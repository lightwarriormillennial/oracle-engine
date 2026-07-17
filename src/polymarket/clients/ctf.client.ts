/**
 * CtfClient — Conditional Tokens Framework (ERC-1155) split/merge for inventory management.
 *
 * On Polymarket, outcome shares are ERC-1155 conditional tokens. The CTF contract lets a
 * maker rebalance inventory without crossing the order-book spread (no taker fee, no slippage):
 *
 *   splitPosition  — deposit N USDC, mint N YES + N NO tokens for a condition
 *   mergePositions — burn N YES + N NO tokens, redeem N USDC
 *
 * This is the poly-maker pattern: when directional inventory skews past the soft band, the
 * maker merges matched pairs back to USDC (flattening) or splits fresh USDC to re-arm a
 * two-sided book, rather than paying spread to unwind.
 *
 * Graceful paper-mode fallback: if POLY_PRIVATE_KEY is unset, methods no-op and log, so the
 * engine runs safely unsigned (mirrors ClobClient behavior).
 */
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ethers, type Contract, type Wallet } from 'ethers';

/** Minimal ABI for the Polymarket ConditionalTokens contract (ERC-1155). */
const CONDITIONAL_TOKENS_ABI = [
  'function splitPosition(address collateralToken, bytes32 parentCollectionId, bytes32 conditionId, uint256[] partition, uint256 amount)',
  'function mergePositions(address collateralToken, bytes32 parentCollectionId, bytes32 conditionId, uint256[] partition, uint256 amount)',
  'function balanceOf(address owner, uint256 id) view returns (uint256)',
  'function balanceOfBatch(address[] owners, uint256[] ids) view returns (uint256[])',
];

/** Minimal ABI for the collateral (USDC) — allowance pre-checks for split. */
const ERC20_ABI = [
  'function approve(address spender, uint256 amount) returns (bool)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function balanceOf(address account) view returns (uint256)',
];

/** Minimal ABI for the Polymarket NegRiskAdapter (negRisk markets route through this). */
const NEGRISK_ADAPTER_ABI = [
  'function splitPosition(bytes32 conditionId, uint256 amount)',
  'function mergePositions(bytes32 conditionId, uint256 amount)',
];

/** Polygon mainnet contract addresses (POLY_CHAIN_ID = 137). */
export const POLYGON_ADDRESSES = {
  usdc: '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174',
  conditionalTokens: '0x4D97DCd97eC945f40cF65F87097ACe5EA0476045',
  negRiskAdapter: '0xC5d563A36AE78145C45a50134d48A1215220f80a',
  negRiskCtfExchange: '0xC5d563A36AE78145C45a50134d48A1215220f80a',
};

/** CTF outcome partition is always the full set [0, 1] on Polymarket binary markets. */
const FULL_PARTITION = [0n, 1n];

/** Polymarket collateral and conditional-token decimals. */
const COLLATERAL_DECIMALS = 6;
const CONDITIONAL_DECIMALS = 6;

export interface CtfInventory {
  yesShares: number;
  noShares: number;
  usdcBalance: number;
}

export type CtfAction = 'split' | 'merge' | 'none';

export interface CtfRebalancePlan {
  action: CtfAction;
  amountUsdc: number;
  reason: string;
}

@Injectable()
export class CtfClient {
  private readonly logger = new Logger(CtfClient.name);
  private readonly chainId: number;
  private readonly rpcUrl: string;
  private readonly proxyAddress?: string;
  private wallet: Wallet | null = null;
  private ctfContract: Contract | null = null;
  private negRiskContract: Contract | null = null;
  private usdcContract: Contract | null = null;
  private readonly enabled: boolean;

  constructor(private config: ConfigService) {
    this.chainId = this.config.get<number>('POLY_CHAIN_ID', 137);
    this.rpcUrl =
      this.config.get<string>('POLY_RPC_URL') ||
      this.config.get<string>('RPC_URL') ||
      'https://polygon-bor-rpc.publicnode.com';
    this.proxyAddress = this.config.get<string>('POLY_PROXY_ADDRESS');
    const privateKey = this.config.get<string>('POLY_PRIVATE_KEY');
    this.enabled = Boolean(privateKey && this.proxyAddress);
    if (!this.enabled) {
      this.logger.warn('POLY_PRIVATE_KEY or POLY_PROXY_ADDRESS not set — CTF split/merge disabled (paper mode only)');
      return;
    }
    try {
      this.wallet = new ethers.Wallet(privateKey!, new ethers.JsonRpcProvider(this.rpcUrl));
      this.ctfContract = new ethers.Contract(
        POLYGON_ADDRESSES.conditionalTokens,
        CONDITIONAL_TOKENS_ABI,
        this.wallet,
      );
      this.negRiskContract = new ethers.Contract(
        POLYGON_ADDRESSES.negRiskAdapter,
        NEGRISK_ADAPTER_ABI,
        this.wallet,
      );
      this.usdcContract = new ethers.Contract(POLYGON_ADDRESSES.usdc, ERC20_ABI, this.wallet);
      this.logger.log(`CTF client initialized: chain=${this.chainId} proxy=${this.proxyAddress}`);
    } catch (e: any) {
      this.logger.error(`Failed to initialize CTF client: ${e.message}`);
      this.enabled = false;
    }
  }

  get isReady(): boolean {
    return this.enabled;
  }

  /** Account (proxy) address used for balance queries and on-chain calls. */
  get accountAddress(): string | undefined {
    return this.proxyAddress;
  }

  /**
   * Split `amountUsdc` of collateral into `amountUsdc` YES + `amountUsdc` NO conditional
   * tokens for `conditionId`. Re-arms a two-sided book without crossing the spread.
   */
  async splitPosition(conditionId: string, amountUsdc: number, negRisk = false): Promise<string | null> {
    if (!this.enabled || !this.ctfContract || !this.wallet || !this.proxyAddress) {
      this.logger.debug(`[no-signing] splitPosition skipped: condition=${conditionId} amount=${amountUsdc}`);
      return null;
    }
    try {
      const amountRaw = ethers.parseUnits(amountUsdc.toFixed(COLLATERAL_DECIMALS), COLLATERAL_DECIMALS);

      if (negRisk && this.negRiskContract) {
        const tx = await this.negRiskContract.splitPosition(conditionId, amountRaw);
        this.logger.log(`[negRisk] splitPosition tx=${tx.hash} condition=${conditionId} amount=${amountUsdc}`);
        await tx.wait();
        return tx.hash;
      }

      // Standard CTF: ensure collateral allowance to the CTF contract, then split.
      await this.ensureAllowance(amountUsdc);
      const tx = await this.ctfContract.splitPosition(
        POLYGON_ADDRESSES.usdc,
        ethers.ZeroHash,
        conditionId,
        FULL_PARTITION,
        amountRaw,
        { from: this.proxyAddress },
      );
      this.logger.log(`splitPosition tx=${tx.hash} condition=${conditionId} amount=${amountUsdc}`);
      await tx.wait();
      return tx.hash;
    } catch (e: any) {
      this.logger.error(`splitPosition failed: ${e.message}`);
      throw e;
    }
  }

  /**
   * Merge `amount` of matched YES + NO conditional tokens back to `amount` USDC for
   * `conditionId`. Flattens directional inventory at zero spread cost.
   */
  async mergePositions(conditionId: string, amount: number, negRisk = false): Promise<string | null> {
    if (!this.enabled || !this.ctfContract || !this.wallet || !this.proxyAddress) {
      this.logger.debug(`[no-signing] mergePositions skipped: condition=${conditionId} amount=${amount}`);
      return null;
    }
    try {
      const amountRaw = ethers.parseUnits(amount.toFixed(CONDITIONAL_DECIMALS), CONDITIONAL_DECIMALS);

      if (negRisk && this.negRiskContract) {
        const tx = await this.negRiskContract.mergePositions(conditionId, amountRaw);
        this.logger.log(`[negRisk] mergePositions tx=${tx.hash} condition=${conditionId} amount=${amount}`);
        await tx.wait();
        return tx.hash;
      }

      const tx = await this.ctfContract.mergePositions(
        POLYGON_ADDRESSES.usdc,
        ethers.ZeroHash,
        conditionId,
        FULL_PARTITION,
        amountRaw,
        { from: this.proxyAddress },
      );
      this.logger.log(`mergePositions tx=${tx.hash} condition=${conditionId} amount=${amount}`);
      await tx.wait();
      return tx.hash;
    } catch (e: any) {
      this.logger.error(`mergePositions failed: ${e.message}`);
      throw e;
    }
  }

  /** Read the ERC-1155 balance of a conditional token for the proxy account. */
  async getBalance(tokenId: string): Promise<number> {
    if (!this.enabled || !this.ctfContract || !this.proxyAddress) return 0;
    try {
      const raw: bigint = await this.ctfContract.balanceOf(this.proxyAddress, BigInt(tokenId));
      return Number(ethers.formatUnits(raw, CONDITIONAL_DECIMALS));
    } catch (e: any) {
      this.logger.warn(`getBalance failed for token=${tokenId}: ${e.message}`);
      return 0;
    }
  }

  /** Read YES/NO/USDC inventory for a binary market. */
  async getInventory(yesTokenId: string, noTokenId: string): Promise<CtfInventory> {
    if (!this.enabled || !this.ctfContract || !this.proxyAddress || !this.usdcContract) {
      return { yesShares: 0, noShares: 0, usdcBalance: 0 };
    }
    try {
      const [yesRaw, noRaw, usdcRaw] = await Promise.all([
        this.ctfContract.balanceOf(this.proxyAddress, BigInt(yesTokenId)),
        this.ctfContract.balanceOf(this.proxyAddress, BigInt(noTokenId)),
        this.usdcContract.balanceOf(this.proxyAddress),
      ]);
      return {
        yesShares: Number(ethers.formatUnits(yesRaw, CONDITIONAL_DECIMALS)),
        noShares: Number(ethers.formatUnits(noRaw, CONDITIONAL_DECIMALS)),
        usdcBalance: Number(ethers.formatUnits(usdcRaw, COLLATERAL_DECIMALS)),
      };
    } catch (e: any) {
      this.logger.warn(`getInventory failed: ${e.message}`);
      return { yesShares: 0, noShares: 0, usdcBalance: 0 };
    }
  }

  /**
   * Decide a CTF rebalance for a binary market given current inventory and a skew cap.
   * Returns the action + amount the engine should execute.
   *
   * - net = yes - no. If |net| exceeds qMaxUsdc * softFrac, merge the smaller side to flatten.
   * - If both sides are below the minimum reward size and USDC is available, split to re-arm.
   */
  planRebalance(
    inventory: CtfInventory,
    opts: { qMaxUsdc: number; softFrac: number; minSize: number; minUsdcReserve: number },
  ): CtfRebalancePlan {
    const { yesShares, noShares, usdcBalance } = inventory;
    const matched = Math.min(yesShares, noShares);
    const net = yesShares - noShares;
    const softCap = opts.qMaxUsdc * opts.softFrac;

    // Flatten directional skew by merging matched pairs toward USDC.
    if (Math.abs(net) > softCap && matched > opts.minSize) {
      const mergeAmount = Math.min(matched, Math.abs(net) - softCap);
      if (mergeAmount >= opts.minSize) {
        return {
          action: 'merge',
          amountUsdc: Math.floor(mergeAmount * 100) / 100,
          reason: `flatten skew net=${net.toFixed(2)} > softCap=${softCap.toFixed(2)}`,
        };
      }
    }

    // Re-arm a thin two-sided book if inventory is depleted but USDC is available.
    const lowInventory = matched < opts.minSize;
    const usdcAvailable = usdcBalance - opts.minUsdcReserve;
    if (lowInventory && usdcAvailable >= opts.minSize) {
      const splitAmount = Math.min(usdcAvailable, opts.qMaxUsdc);
      return {
        action: 'split',
        amountUsdc: Math.floor(splitAmount * 100) / 100,
        reason: `re-arm two-sided book matched=${matched.toFixed(2)} < minSize=${opts.minSize}`,
      };
    }

    return { action: 'none', amountUsdc: 0, reason: 'inventory within bands' };
  }

  private async ensureAllowance(amountUsdc: number): Promise<void> {
    if (!this.usdcContract || !this.wallet || !this.proxyAddress) return;
    const amountRaw = ethers.parseUnits(amountUsdc.toFixed(COLLATERAL_DECIMALS), COLLATERAL_DECIMALS);
    const current: bigint = await this.usdcContract.allowance(this.proxyAddress, POLYGON_ADDRESSES.conditionalTokens);
    if (current >= amountRaw) return;
    const approveTx = await this.usdcContract.approve(POLYGON_ADDRESSES.conditionalTokens, ethers.MaxUint256);
    this.logger.debug(`USDC approve tx=${approveTx.hash}`);
    await approveTx.wait();
  }
}
