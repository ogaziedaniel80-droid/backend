import { describe, it, expect, vi } from 'vitest';
import { Keypair, MemoText } from '@stellar/stellar-sdk';
import { buildPaymentTransaction, estimateTransactionFee } from './transactions';
import { MEMO_MAX_LENGTH } from './validation';

const sender = Keypair.random().publicKey();
const recipient = Keypair.random().publicKey();

// Horizon is never contacted: the client hands back a local account so the
// builder can be exercised offline.
vi.mock('./client', async () => {
  const sdk = await import('@stellar/stellar-sdk');
  return {
      getStellarClient: () => ({
        getServer: () => ({
          loadAccount: async (publicKey: string) => new sdk.Account(publicKey, '1'),
        }),
        getNetworkPassphrase: () => sdk.Networks.TESTNET,
        getNetworkType: () => 'testnet',
        getNetworkStatus: async () => ({ baseFee: 100, ledgerVersion: 1 }),
      }),
  };
});

describe('buildPaymentTransaction memo limit (#180)', () => {
  const payment = (memo: string) => ({
    senderPublicKey: sender,
    recipientPublicKey: recipient,
    amount: '1',
    memo,
  });

  it('accepts a memo of exactly 28 bytes', async () => {
    const memo = 'a'.repeat(MEMO_MAX_LENGTH);

    const transaction = await buildPaymentTransaction(payment(memo));

    expect(transaction.source).toBe(sender);
    expect(transaction.memo.type).toBe(MemoText);
    expect(Buffer.from(transaction.memo.value).toString('utf8')).toBe(memo);
  });

  it('rejects a memo over 28 bytes even when it is under 28 characters', async () => {
    // 15 two byte characters: 15 characters, 30 bytes.
    await expect(buildPaymentTransaction(payment('é'.repeat(15)))).rejects.toThrow(
      `Memo text must be ${MEMO_MAX_LENGTH} bytes or less`
    );
  });
});

describe('estimateTransactionFee (#187)', () => {
  it('returns baseFee * operationCount from the latest ledger', async () => {
    const estimate = await estimateTransactionFee(1);
    expect(estimate).toEqual({ fee: 100, baseFee: 100, operationCount: 1 });
  });

  it('scales the fee with the operation count', async () => {
    const estimate = await estimateTransactionFee(3);
    expect(estimate.fee).toBe(300);
    expect(estimate.baseFee).toBe(100);
    expect(estimate.operationCount).toBe(3);
  });

  it('defaults to a single operation', async () => {
    const estimate = await estimateTransactionFee();
    expect(estimate.operationCount).toBe(1);
    expect(estimate.fee).toBe(estimate.baseFee);
  });
});
