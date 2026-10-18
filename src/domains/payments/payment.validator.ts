import { PrismaClient } from '@prisma/client';
import { MAX_PAYMENT_AMOUNT, MEMO_MAX_LENGTH } from '../../lib/stellar/validation';

/**
 * Payment business validation.
 *
 * All payment-specific business rules (amount limits, wallet eligibility,
 * asset eligibility, memo size) live here so they can be exercised by the
 * HTTP layer, the service layer, jobs, and tests without duplicating logic or
 * coupling any of them to Prisma models or Fastify schemas.
 */

export interface ValidationResult {
  valid: boolean;
  reason?: string;
}

export interface AmountValidationResult extends ValidationResult {
  value?: number;
}

/**
 * Validates a payment amount: positive, finite, at most 7 decimals (Stellar
 * precision) and within the configured upper bound.
 */
export function validateAmount(amount: unknown): AmountValidationResult {
  const value = typeof amount === 'string' ? Number(amount) : amount;

  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return { valid: false, reason: 'Amount must be a finite number' };
  }

  if (value <= 0) {
    return { valid: false, reason: 'Amount must be greater than 0' };
  }

  if (value > MAX_PAYMENT_AMOUNT) {
    return { valid: false, reason: `Amount must not exceed ${MAX_PAYMENT_AMOUNT}` };
  }

  const decimals = `${value}`.split('.')[1];
  if (decimals && decimals.length > 7) {
    return { valid: false, reason: 'Amount supports at most 7 decimal places' };
  }

  return { valid: true, value };
}

export interface MemoValidationResult extends ValidationResult {}

/**
 * Validates a transaction memo against Stellar's 28 byte text memo limit.
 * Multibyte characters are counted by their UTF-8 byte length. A missing memo
 * is valid (the caller derives one from the tip id).
 */
export function validateMemo(memo: unknown): MemoValidationResult {
  if (memo === undefined || memo === null) {
    return { valid: true };
  }

  if (typeof memo !== 'string') {
    return { valid: false, reason: 'Memo must be a string' };
  }

  const length = Buffer.byteLength(memo, 'utf8');
  if (length > MEMO_MAX_LENGTH) {
    return {
      valid: false,
      reason: `Memo must be at most ${MEMO_MAX_LENGTH} UTF-8 bytes (got ${length})`,
    };
  }

  return { valid: true };
}

export interface WalletValidationResult extends ValidationResult {
  wallet?: { id: string; publicKey: string };
  /** True when a verified wallet exists but is flagged and must not send payments. */
  flagged?: boolean;
}

/**
 * Validates wallet eligibility for sending payments: the user must have a
 * verified wallet and that wallet must not carry an unresolved medium/high /
 * critical flag.
 */
export async function validateWallet(
  prisma: PrismaClient,
  userId: string
): Promise<WalletValidationResult> {
  const wallet = await prisma.wallet.findFirst({
    where: { userId, verified: true },
    select: { id: true, publicKey: true },
  });

  if (!wallet) {
    return { valid: false, reason: 'User does not have a verified wallet' };
  }

  const walletFlag = await prisma.walletFlag.findFirst({
    where: {
      address: wallet.publicKey,
      resolved: false,
      severity: { in: ['medium', 'high', 'critical'] },
    },
    select: { id: true },
  });

  if (walletFlag) {
    return { valid: false, reason: 'Wallet is flagged and cannot send payments', wallet, flagged: true };
  }

  return { valid: true, wallet };
}

export interface AssetValidationResult extends ValidationResult {
  asset?: { id: string; code: string; issuer: string | null; decimals: number };
}

/**
 * Validates asset eligibility for a payment. When `assetId` is supplied it must
 * reference an enabled asset; otherwise the default enabled USDC asset is used.
 */
export async function validateAsset(
  prisma: PrismaClient,
  assetId?: string
): Promise<AssetValidationResult> {
  const asset = assetId
    ? await prisma.stellarAsset.findFirst({ where: { id: assetId, enabled: true } })
    : await prisma.stellarAsset.findFirst({
        where: { enabled: true, code: 'USDC' },
        orderBy: { priority: 'desc' },
      });

  if (assetId && !asset) {
    return { valid: false, reason: `Asset '${assetId}' is not supported` };
  }

  if (!asset) {
    return { valid: false, reason: 'No enabled payment asset available' };
  }

  return {
    valid: true,
    asset: { id: asset.id, code: asset.code, issuer: asset.issuer, decimals: asset.decimals },
  };
}
