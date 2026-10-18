import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MAX_PAYMENT_AMOUNT, MEMO_MAX_LENGTH } from '../../../lib/stellar/validation';
import { validateAmount, validateAsset, validateMemo, validateWallet } from '../payment.validator';

const baseWallet = { id: 'wallet-1', publicKey: 'GAAAAA...', verified: true };

const mockPrisma = (overrides: Record<string, any> = {}) => {
  const walletFindFirst = vi.fn();
  const walletFlagFindFirst = vi.fn();
  const stellarAssetFindFirst = vi.fn();

  return {
    wallet: { findFirst: walletFindFirst },
    walletFlag: { findFirst: walletFlagFindFirst },
    stellarAsset: { findFirst: stellarAssetFindFirst },
    ...overrides,
    __mocks: { walletFindFirst, walletFlagFindFirst, stellarAssetFindFirst },
  } as any;
};

describe('validateAmount', () => {
  it('accepts a positive integer amount', () => {
    expect(validateAmount(25)).toMatchObject({ valid: true, value: 25 });
  });

  it('accepts a positive decimal amount with up to 7 decimals', () => {
    expect(validateAmount('10.5')).toMatchObject({ valid: true, value: 10.5 });
    expect(validateAmount('0.0000001')).toMatchObject({ valid: true, value: 0.0000001 });
  });

  it('accepts the maximum allowed amount', () => {
    expect(validateAmount(MAX_PAYMENT_AMOUNT).valid).toBe(true);
  });

  it('rejects zero and negative amounts', () => {
    expect(validateAmount(0).valid).toBe(false);
    expect(validateAmount(0).reason).toBe('Amount must be greater than 0');
    expect(validateAmount(-10).valid).toBe(false);
    expect(validateAmount(-0.01).valid).toBe(false);
  });

  it('rejects non-finite amounts', () => {
    expect(validateAmount(Number.POSITIVE_INFINITY).valid).toBe(false);
    expect(validateAmount(Number.NEGATIVE_INFINITY).valid).toBe(false);
    expect(validateAmount(NaN).valid).toBe(false);
  });

  it('rejects non-numeric strings and missing values', () => {
    expect(validateAmount('abc').valid).toBe(false);
    expect(validateAmount('').valid).toBe(false);
    expect(validateAmount(undefined).valid).toBe(false);
    expect(validateAmount(null).valid).toBe(false);
  });

  it('rejects amounts above the maximum', () => {
    const result = validateAmount(MAX_PAYMENT_AMOUNT + 1);
    expect(result.valid).toBe(false);
    expect(result.reason).toContain(String(MAX_PAYMENT_AMOUNT));
  });

  it('rejects more than 7 decimal places', () => {
    expect(validateAmount(1.12345678).valid).toBe(false);
    expect(validateAmount('1.12345678').valid).toBe(false);
  });
});

describe('validateMemo', () => {
  it('allows a missing memo', () => {
    expect(validateMemo(undefined)).toEqual({ valid: true });
    expect(validateMemo(null)).toEqual({ valid: true });
  });

  it('accepts a memo of exactly 28 bytes', () => {
    const memo = 'a'.repeat(MEMO_MAX_LENGTH);
    expect(validateMemo(memo)).toEqual({ valid: true });
  });

  it('rejects a memo over 28 bytes', () => {
    const result = validateMemo('a'.repeat(MEMO_MAX_LENGTH + 1));
    expect(result.valid).toBe(false);
    expect(result.reason).toContain(String(MEMO_MAX_LENGTH));
  });

  it('counts UTF-8 bytes rather than characters', () => {
    // 15 two-byte characters need 30 bytes.
    expect(validateMemo('é'.repeat(15)).valid).toBe(false);
    // 7 four-byte characters are exactly 28 bytes.
    expect(validateMemo('\u{1F600}'.repeat(7)).valid).toBe(true);
    expect(validateMemo('\u{1F600}'.repeat(8)).valid).toBe(false);
  });

  it('rejects a non-string memo', () => {
    expect(validateMemo(42).valid).toBe(false);
    expect(validateMemo(42).reason).toBe('Memo must be a string');
  });
});

describe('validateWallet', () => {
  let prisma: any;

  beforeEach(() => {
    prisma = mockPrisma();
  });

  it('is valid when the user has a verified wallet that is not flagged', async () => {
    prisma.__mocks.walletFindFirst.mockResolvedValue(baseWallet);
    prisma.__mocks.walletFlagFindFirst.mockResolvedValue(null);

    const result = await validateWallet(prisma, 'user-1');

    expect(result.valid).toBe(true);
    expect(result.flagged).toBeUndefined();
    expect(result.wallet).toEqual(baseWallet);
    expect(prisma.wallet.findFirst).toHaveBeenCalledWith({
      where: { userId: 'user-1', verified: true },
      select: { id: true, publicKey: true },
    });
    expect(prisma.walletFlag.findFirst).toHaveBeenCalledWith({
      where: {
        address: baseWallet.publicKey,
        resolved: false,
        severity: { in: ['medium', 'high', 'critical'] },
      },
      select: { id: true },
    });
  });

  it('is invalid when the user has no verified wallet', async () => {
    prisma.__mocks.walletFindFirst.mockResolvedValue(null);

    const result = await validateWallet(prisma, 'user-1');

    expect(result.valid).toBe(false);
    expect(result.flagged).toBeUndefined();
    expect(result.reason).toBe('User does not have a verified wallet');
    expect(prisma.walletFlag.findFirst).not.toHaveBeenCalled();
  });

  it('is invalid and flagged when the wallet carries an unresolved critical flag', async () => {
    prisma.__mocks.walletFindFirst.mockResolvedValue(baseWallet);
    prisma.__mocks.walletFlagFindFirst.mockResolvedValue({ id: 'flag-1' });

    const result = await validateWallet(prisma, 'user-1');

    expect(result.valid).toBe(false);
    expect(result.flagged).toBe(true);
    expect(result.reason).toBe('Wallet is flagged and cannot send payments');
    expect(result.wallet).toEqual(baseWallet);
  });

  it('is valid when the only flag is resolved', async () => {
    prisma.__mocks.walletFindFirst.mockResolvedValue(baseWallet);
    prisma.__mocks.walletFlagFindFirst.mockResolvedValue(null);

    const result = await validateWallet(prisma, 'user-1');

    expect(result.valid).toBe(true);
  });
});

describe('validateAsset', () => {
  let prisma: any;
  const usdcAsset = { id: 'asset-usdc', code: 'USDC', issuer: 'GUSDCISSUER', decimals: 7 };

  beforeEach(() => {
    prisma = mockPrisma();
  });

  it('returns the requested enabled asset when assetId is supplied', async () => {
    prisma.__mocks.stellarAssetFindFirst.mockResolvedValue(usdcAsset);

    const result = await validateAsset(prisma, 'asset-usdc');

    expect(result.valid).toBe(true);
    expect(result.asset).toEqual(usdcAsset);
    expect(prisma.stellarAsset.findFirst).toHaveBeenCalledWith({
      where: { id: 'asset-usdc', enabled: true },
    });
  });

  it('is invalid when the requested asset does not exist or is disabled', async () => {
    prisma.__mocks.stellarAssetFindFirst.mockResolvedValue(null);

    const result = await validateAsset(prisma, 'asset-missing');

    expect(result.valid).toBe(false);
    expect(result.reason).toContain('asset-missing');
    expect(result.reason).toContain('not supported');
  });

  it('defaults to the enabled USDC asset when no assetId is supplied', async () => {
    prisma.__mocks.stellarAssetFindFirst.mockResolvedValue(usdcAsset);

    const result = await validateAsset(prisma);

    expect(result.valid).toBe(true);
    expect(result.asset).toEqual(usdcAsset);
    expect(prisma.stellarAsset.findFirst).toHaveBeenCalledWith({
      where: { enabled: true, code: 'USDC' },
      orderBy: { priority: 'desc' },
    });
  });

  it('is invalid when no enabled payment asset is available', async () => {
    prisma.__mocks.stellarAssetFindFirst.mockResolvedValue(null);

    const result = await validateAsset(prisma);

    expect(result.valid).toBe(false);
    expect(result.reason).toBe('No enabled payment asset available');
  });
});
