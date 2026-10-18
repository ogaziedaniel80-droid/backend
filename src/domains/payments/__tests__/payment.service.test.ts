import { describe, it, expect, beforeEach, vi } from 'vitest';

// Stub out BullMQ queues so the service can be imported without a Redis connection.
vi.mock('../../../lib/queue', () => ({
  stellarConfirmationQueue: { add: vi.fn() },
  webhookDispatchQueue: { add: vi.fn() },
}));

// Stub Stellar transaction helpers — not exercised in balance-check tests.
vi.mock('../../../lib/stellar/transactions', () => ({
  buildPaymentTransaction: vi.fn(),
  submitSignedTransaction: vi.fn(),
  checkTransactionStatus: vi.fn(),
  estimateTransactionFee: vi.fn().mockResolvedValue({ fee: 100, baseFee: 100, operationCount: 1 }),
}));

// Stub getWalletBalance so tests stay hermetic (no Stellar network).
vi.mock('../../../lib/stellar/wallet', () => ({
  getWalletBalance: vi.fn(),
}));

import { PaymentService } from '../payment.service';
import { PaymentRequiredError, ServiceUnavailableError } from '../../../utils/errors';
import { getWalletBalance } from '../../../lib/stellar/wallet';

const mockGetWalletBalance = getWalletBalance as ReturnType<typeof vi.fn>;

// ---------------------------------------------------------------------------
// Static vi.fn Prisma double — same shape used by tip-concurrency.test.ts
// ---------------------------------------------------------------------------

const mockPrisma = {
  creator: { findUnique: vi.fn(), update: vi.fn() },
  user: { findUnique: vi.fn() },
  wallet: { findFirst: vi.fn() },
  stellarAsset: { findFirst: vi.fn() },
  walletFlag: { findFirst: vi.fn() },
  accountFreeze: { findFirst: vi.fn() },
  webhook: { findMany: vi.fn() },
  tip: {
    create: vi.fn(),
    findUnique: vi.fn(),
    findMany: vi.fn(),
    count: vi.fn(),
    update: vi.fn(),
    updateMany: vi.fn(),
  },
  $transaction: vi.fn((callback: (tx: any) => Promise<unknown>) => callback(mockPrisma)),
};

describe('PaymentService.createTip — balance checks (#175)', () => {
  const userId = 'user-balance';
  const creatorId = 'creator-ok';
  let service: PaymentService;

  beforeEach(() => {
    vi.clearAllMocks();
    service = new PaymentService(mockPrisma as any);
    mockPrisma.webhook.findMany.mockResolvedValue([]);

    // Default happy-path mocks shared by all tests in this suite
    mockPrisma.user.findUnique.mockResolvedValue({ id: userId });
    mockPrisma.creator.findUnique.mockResolvedValue({
      id: creatorId,
      userId: 'other-user',
      isPublic: true,
      verified: true,
    });
    mockPrisma.wallet.findFirst.mockResolvedValue({
      id: 'wallet-1',
      publicKey: 'GABC123',
      verified: true,
    });
    mockPrisma.walletFlag.findFirst.mockResolvedValue(null);
    mockPrisma.accountFreeze.findFirst.mockResolvedValue(null);
    mockPrisma.stellarAsset.findFirst.mockResolvedValue({
      id: 'asset-usdc',
      code: 'USDC',
      issuer: 'GUSDCISSUER',
      enabled: true,
      priority: 100,
    });

    // Default: wallet has ample balance — existing tests that run alongside pass.
    mockGetWalletBalance.mockResolvedValue({ lumens: '100', usdc: '1000' });
  });

  it('throws PaymentRequiredError (402) when wallet has insufficient USDC balance and creates no DB record', async () => {
    // USDC balance is only 5; tip amount is 100
    mockGetWalletBalance.mockResolvedValue({ lumens: '500', usdc: '5' });

    await expect(
      service.createTip(userId, { creatorId, amount: 100 })
    ).rejects.toMatchObject({
      statusCode: 402,
      code: 'PAYMENT_REQUIRED',
      details: { requiredAmount: 100, currentBalance: 5, currency: 'USDC' },
    });

    expect(mockPrisma.tip.create).not.toHaveBeenCalled();
  });

  it('throws PaymentRequiredError (402) when USDC balance is missing (undefined) and creates no DB record', async () => {
    // No USDC trustline — usdc field absent; treated as 0
    mockGetWalletBalance.mockResolvedValue({ lumens: '100' });

    await expect(
      service.createTip(userId, { creatorId, amount: 10 })
    ).rejects.toMatchObject({
      statusCode: 402,
      code: 'PAYMENT_REQUIRED',
    });

    expect(mockPrisma.tip.create).not.toHaveBeenCalled();
  });

  it('throws ServiceUnavailableError (503) when getWalletBalance fails and creates no DB record', async () => {
    mockGetWalletBalance.mockRejectedValue(new Error('Stellar network unreachable'));

    await expect(
      service.createTip(userId, { creatorId, amount: 50 })
    ).rejects.toMatchObject({ statusCode: 503 });

    expect(mockPrisma.tip.create).not.toHaveBeenCalled();
  });

  it('proceeds to create the tip when balance is exactly equal to amount', async () => {
    mockGetWalletBalance.mockResolvedValue({ lumens: '100', usdc: '25' });

    mockPrisma.tip.findUnique.mockResolvedValue(null);
    mockPrisma.tip.create.mockResolvedValue({
      id: 'tip-exact',
      fromUserId: userId,
      creatorId,
      amount: 25,
      message: null,
      status: 'pending',
      transactionHash: null,
      assetCode: 'USDC',
      assetIssuer: 'GUSDCISSUER',
      assetDecimals: 7,
      moderationState: 'visible',
      createdAt: new Date(),
      updatedAt: new Date(),
      idempotencyKey: null,
      media: [],
    });

    const result = await service.createTip(userId, { creatorId, amount: 25 });

    expect(result.id).toBe('tip-exact');
    expect(result.fee).toBe(100);
    expect(result.totalAmount).toBe(125);
    expect(mockPrisma.tip.create).toHaveBeenCalledTimes(1);
  });
});
