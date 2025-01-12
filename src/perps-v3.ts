import {
  Account,
  CollateralChange,
  DelegatedAccount,
  FundingRatePeriod,
  FundingRateUpdate,
  InterestCharged,
  OpenPerpsV3Position,
  OrderCommitted,
  OrderSettled,
  PendingOrder,
  PerpsV3AggregateStat,
  PerpsV3Market,
  PerpsV3Position,
  PerpsV3Stat,
  SettlementStrategy,
  PnlSnapshot,
  MarketPriceUpdate,
  PositionLiquidation,
  PreviousOrderExpired,
} from '../generated/schema';
import {
  AccountCreated,
  MarketUpdated,
  OrderSettled as OrderSettledEvent,
  PositionLiquidated as PositionLiquidatedEvent,
  PermissionGranted as PermissionGrantedEvent,
  PermissionRevoked as PermissionRevokedEvent,
  CollateralModified as CollateralModifiedEvent,
  OrderCommitted as OrderCommittedEvent,
  InterestCharged as InterestChargedEvent,
  PreviousOrderExpired as PreviousOrderExpiredEvent
} from '../generated/PerpsV3/PerpsV3MarketProxy';
import { BigInt, log, store } from '@graphprotocol/graph-ts';
import {
  DAY_SECONDS,
  ETHER,
  FUNDING_RATE_PERIODS,
  FUNDING_RATE_PERIOD_TYPES,
  ONE,
  ONE_HOUR_SECONDS,
  ZERO,
  getTimeID,
  strToBytes,
} from './helpers';
import {
  MarketCreated,
  SettlementStrategyAdded,
  SettlementStrategySet,
} from '../generated/PerpsV3/PerpsV3MarketProxy';
const AGG_PERIODS = [ONE_HOUR_SECONDS, DAY_SECONDS];

export function handleMarketCreated(event: MarketCreated): void {
  let marketId = event.params.perpsMarketId.toString();
  let market = new PerpsV3Market(marketId);
  market.lastPrice = ZERO;
  market.marketSymbol = event.params.marketSymbol;
  market.marketName = event.params.marketName;
  market.save();
}

export function handleAccountCreated(event: AccountCreated): void {
  const accountId = event.params.accountId;
  let account = Account.load(accountId.toString());

  if (account == null) {
    account = new Account(accountId.toString());
    account.owner = event.params.owner;
    account.created_at = event.block.timestamp;
    account.created_at_block = event.block.number;
    account.updated_at = event.block.timestamp;
    account.updated_at_block = event.block.number;
    account.permissions = [];
    account.save();
  }
}

export function handlePositionLiquidated(event: PositionLiquidatedEvent): void {
  const positionId = event.params.marketId.toString() + '-' + event.params.accountId.toString();
  const openPosition = OpenPerpsV3Position.load(positionId);

  let account = Account.load(event.params.accountId.toString());
  let market = PerpsV3Market.load(event.params.marketId.toString());
  if (market === null) {
    log.error('Market not found for marketId: {}', [event.params.marketId.toString()]);
    return;
  }

  if (account === null) {
    log.error('Account not found for accountId: {}', [event.params.accountId.toString()]);
    return;
  }

  let estiamtedNotionalSize = event.params.amountLiquidated.abs().times(market.lastPrice).div(ETHER).abs();
  let liquidation = new PositionLiquidation(
    event.params.marketId.toString() + '-' + event.params.accountId.toString() + '-' + event.block.timestamp.toString(),
  );
  liquidation.marketId = event.params.marketId;
  liquidation.amount = event.params.amountLiquidated;
  liquidation.accountId = event.params.accountId;
  liquidation.accountOwner = account.owner;
  liquidation.notionalAmount = estiamtedNotionalSize;
  liquidation.estimatedPrice = market.lastPrice;
  liquidation.timestamp = event.block.timestamp;
  liquidation.save();

  let statId = event.params.accountId.toString() + '-' + account.owner.toHexString();
  let statEntity = PerpsV3Stat.load(statId);

  if (openPosition === null) {
    log.warning('Position entity not found for positionId {}', [positionId]);
    return;
  } else if (openPosition.position !== null) {
    let positionEntity = PerpsV3Position.load(openPosition.position!);
    if (positionEntity !== null) {
      const accountBalance = CollateralChange.load(event.params.accountId.toString())
      positionEntity.isLiquidated = true;
      positionEntity.liquidation = liquidation.id;
      positionEntity.isOpen = false;
      openPosition.position = null;
      positionEntity.txnHash =   event.transaction.hash.toHex();
      positionEntity.exitPrice = market.lastPrice || new BigInt(0)
      positionEntity.closeTimestamp = event.block.timestamp
      positionEntity.realizedPnl = positionEntity.netFunding 
      positionEntity.pnlWithFeesPaid = positionEntity.netFunding.minus(positionEntity.feesPaid)
      positionEntity.collateral = accountBalance ?  accountBalance.amountDelta || new BigInt(0) :  new BigInt(0)
      positionEntity.save();
      openPosition.save();

      if (statEntity) {
        statEntity.liquidations = statEntity.liquidations.plus(BigInt.fromI32(1));
        statEntity.save();
      }
    }
  }
}

export function handleOrderSettled(event: OrderSettledEvent): void {
  const orderId = event.params.accountId.toString() + '-' + event.block.timestamp.toString();
  const order = new OrderSettled(orderId);

  const pendingOrderId = event.params.accountId.toString() + '-' + event.params.marketId.toString();
  const pendingOrder = PendingOrder.load(pendingOrderId);

  if (pendingOrder !== null) {
    order.orderCommitted = pendingOrder.orderCommittedId;
    const orderCommitted =  OrderCommitted.load(pendingOrder.orderCommittedId);
    if(orderCommitted){ orderCommitted.status = 'SETTLED'
      orderCommitted.save()

    }
    store.remove('PendingOrder', pendingOrderId);
  }
  order.txnHash = event.transaction.hash.toHex();
  order.accountId = event.params.accountId;
  order.account = event.params.accountId.toString();
  order.accruedFunding = event.params.accruedFunding;
  order.collectedFees = event.params.collectedFees;
  order.fillPrice = event.params.fillPrice;
  order.marketId = event.params.marketId;
  order.timestamp = event.block.timestamp;
  order.totalFees = event.params.totalFees;
  order.trackingCode = event.params.trackingCode;
  order.settlementReward = event.params.settlementReward;
  order.sizeDelta = event.params.sizeDelta;
  order.newSize = event.params.newSize;
  order.referralFees = event.params.referralFees;
  order.settler = event.params.settler;
  order.txnHash = event.transaction.hash.toHex();
  order.pnl = ZERO;
  // we can add an state status  : 

  let interestChargedItem = InterestCharged.load(
    event.params.accountId.toString() + '-' + event.transaction.hash.toHex(),
  );
  if (interestChargedItem !== null) {
    order.interestCharged = interestChargedItem.interest;
  }

  let positionId = event.params.marketId.toString() + '-' + event.params.accountId.toString();
  let openPositionEntity = OpenPerpsV3Position.load(positionId);
  if (openPositionEntity == null) {
    openPositionEntity = new OpenPerpsV3Position(positionId);
  }

  let positionEntity = PerpsV3Position.load(openPositionEntity.position !== null ? openPositionEntity.position! : '');
  let volume = order.sizeDelta.abs().times(order.fillPrice).div(ETHER).abs();
  let account = Account.load(order.account);

  if (account === null) {
    log.error('Account not found for accountId: {}', [order.account.toString()]);
    return;
  }

  let statId = event.params.accountId.toString() + '-' + account.owner.toHexString();
  let statEntity = PerpsV3Stat.load(statId);

  if (statEntity == null) {
    statEntity = new PerpsV3Stat(statId);
    statEntity.accountId = event.params.accountId;
    statEntity.accountOwner = account.owner;
    statEntity.feesPaid = ZERO;
    statEntity.pnl = ZERO;
    statEntity.pnlWithFeesPaid = ZERO;
    statEntity.liquidations = ZERO;
    statEntity.totalTrades = ZERO;
    statEntity.totalVolume = ZERO;
    statEntity.save();
  }
// collateral 
/**
 *  type open or close 
 *  
 */
const accountBalance = CollateralChange.load(event.params.accountId.toString())
  if (positionEntity == null) {
    let marketEntity = PerpsV3Market.load(event.params.marketId.toString());

    if (marketEntity == null) {
      log.warning('Market entity not found for marketId {}', [event.params.marketId.toString()]);
      return;
    }

    let positionEntity = new PerpsV3Position(positionId + '-' + event.block.timestamp.toString());
    openPositionEntity.position = positionEntity.id;

    positionEntity.marketId = event.params.marketId;
    if (marketEntity) {
      positionEntity.marketSymbol = marketEntity.marketSymbol;
    }
    
    positionEntity.accountId = event.params.accountId;
    positionEntity.account = event.params.accountId.toString();
    positionEntity.isLiquidated = false;
    positionEntity.isOpen = true;
    positionEntity.size = event.params.sizeDelta;
    positionEntity.timestamp = event.block.timestamp;
    positionEntity.openTimestamp = event.block.timestamp;
    positionEntity.avgEntryPrice = event.params.fillPrice;
    positionEntity.totalTrades = BigInt.fromI32(1);
    positionEntity.entryPrice = event.params.fillPrice;
    positionEntity.lastPrice = event.params.fillPrice;
    positionEntity.feesPaid = event.params.totalFees;
    positionEntity.netFunding = event.params.accruedFunding;
    positionEntity.realizedPnl = positionEntity.netFunding;
    positionEntity.pnlWithFeesPaid = positionEntity.netFunding.minus(positionEntity.feesPaid);
    positionEntity.totalVolume = volume;
    positionEntity.totalReducedNotional = ZERO;
    positionEntity.interestCharged = ZERO;
    positionEntity.txnHash = event.transaction.hash.toHex();
    positionEntity.collateral = accountBalance ?  accountBalance.amountDelta || new BigInt(0) :  new BigInt(0)
    // if (event.params.trackingCode.toString() == 'KWENTA') {
    //   updateAggregateStatEntities(
    //     positionEntity.marketId,
    //     positionEntity.marketSymbol,
    //     event.block.timestamp,
    //     ONE,
    //     volume,
    //   );
    // }

    statEntity.feesPaid = statEntity.feesPaid.plus(event.params.totalFees);
    statEntity.totalTrades = statEntity.totalTrades.plus(BigInt.fromI32(1));
    statEntity.totalVolume = statEntity.totalVolume.plus(volume);

    positionEntity.save();
    order.position = positionEntity.id;
    statEntity.save();
  } else {
    const tradeNotionalValue = event.params.sizeDelta.abs().times(event.params.fillPrice);

    positionEntity.feesPaid = positionEntity.feesPaid.plus(event.params.totalFees);
    positionEntity.netFunding = positionEntity.netFunding.plus(event.params.accruedFunding);

    if (event.params.newSize.isZero()) {
      positionEntity.isOpen = false;
      positionEntity.closeTimestamp = event.block.timestamp;
      positionEntity.exitPrice = event.params.fillPrice;
      positionEntity.totalReducedNotional = positionEntity.totalReducedNotional.plus(tradeNotionalValue);
      openPositionEntity.position = null;
      openPositionEntity.save();

      calculatePnl(positionEntity, order, event, statEntity);
    } else {
      if (
        (positionEntity.size.lt(ZERO) && event.params.newSize.gt(ZERO)) ||
        (positionEntity.size.gt(ZERO) && event.params.newSize.lt(ZERO))
      ) {
        // TODO: Better handle flipping sides
        calculatePnl(positionEntity, order, event, statEntity);
        positionEntity.avgEntryPrice = event.params.fillPrice;
        positionEntity.entryPrice = event.params.fillPrice;
      } else if (event.params.newSize.abs().gt(positionEntity.size.abs())) {
        // If ths positions size is increasing then recalculate the average entry price
        const existingNotionalValue = positionEntity.size.abs().times(positionEntity.avgEntryPrice);
        positionEntity.avgEntryPrice = existingNotionalValue.plus(tradeNotionalValue).div(event.params.newSize.abs());
      } else {
        // If decreasing calc the pnl
        calculatePnl(positionEntity, order, event, statEntity);
        // Track the total amount reduced
      }
    }
    positionEntity.totalTrades = positionEntity.totalTrades.plus(BigInt.fromI32(1));
    positionEntity.totalVolume = positionEntity.totalVolume.plus(volume);

    statEntity.totalTrades = statEntity.totalTrades.plus(BigInt.fromI32(1));
    statEntity.totalVolume = statEntity.totalVolume.plus(volume);
    order.position = positionEntity.id;
    positionEntity.collateral = accountBalance ?  accountBalance.amountDelta || new BigInt(0) :  new BigInt(0)
if(!event.params.newSize.isZero()){ // this only happens when we close an position while closing position we want to keep the size
  positionEntity.size = positionEntity.size.plus(event.params.sizeDelta);
}
     
    // if (event.params.trackingCode.toString() == 'KWENTA') {
    //   updateAggregateStatEntities(
    //     positionEntity.marketId,
    //     positionEntity.marketSymbol,
    //     event.block.timestamp,
    //     ONE,
    //     volume,
    //   );
    // }

    statEntity.feesPaid = statEntity.feesPaid.plus(event.params.totalFees).minus(event.params.accruedFunding);

    positionEntity.save();
    statEntity.save();
  }
  openPositionEntity.save();

  log.info('Order Settled: {} {}', [order.account.toString(), event.block.number.toString()]);

  order.save();
}

export function handleSettlementStrategyAdded(event: SettlementStrategyAdded): void {
  const id = event.params.strategyId.toString() + '-' + event.params.marketId.toString();
  const strategy = new SettlementStrategy(id);

  strategy.strategyId = event.params.strategyId;
  strategy.marketId = event.params.marketId;

  strategy.strategyType = event.params.strategy.strategyType;
  strategy.settlementDelay = event.params.strategy.settlementDelay;
  strategy.settlementWindowDuration = event.params.strategy.settlementWindowDuration;
  strategy.priceVerificationContract = event.params.strategy.priceVerificationContract.toHexString();
  strategy.commitmentPriceDelay = event.params.strategy.commitmentPriceDelay;
  strategy.feedId = event.params.strategy.feedId;
  strategy.settlementReward = event.params.strategy.settlementReward;
  strategy.enabled = !event.params.strategy.disabled;

  strategy.save();
}

export function handleSettlementStrategyEnabled(event: SettlementStrategySet): void {
  const id = event.params.strategyId.toString() + '-' + event.params.marketId.toString();
  const strategy = SettlementStrategy.load(id);

  if (!strategy) {
    return;
  }

  strategy.enabled = !event.params.strategy.disabled;
  strategy.strategyType = event.params.strategy.strategyType;
  strategy.settlementDelay = event.params.strategy.settlementDelay;
  strategy.settlementWindowDuration = event.params.strategy.settlementWindowDuration;
  strategy.priceVerificationContract = event.params.strategy.priceVerificationContract.toHexString();
  strategy.commitmentPriceDelay = event.params.strategy.commitmentPriceDelay;
  strategy.feedId = event.params.strategy.feedId;
  strategy.settlementReward = event.params.strategy.settlementReward;
  strategy.save();
}

export function handleMarketUpdated(event: MarketUpdated): void {
  let marketEntity = PerpsV3Market.load(event.params.marketId.toString());

  let price = event.params.price;
  let timestamp = event.block.timestamp;

  let marketPriceUpdate = new MarketPriceUpdate(
    price.toString() + '-' + timestamp.toString() + '-' + event.params.marketId.toString(),
  );
  marketPriceUpdate.marketId = event.params.marketId;
  marketPriceUpdate.timestamp = timestamp;
  marketPriceUpdate.price = price;
  marketPriceUpdate.save();

  let fundingRateUpdateEntity = new FundingRateUpdate(
    event.params.marketId.toString() + '-' + event.transaction.hash.toHex(),
  );

  fundingRateUpdateEntity.timestamp = event.block.timestamp;
  fundingRateUpdateEntity.marketId = event.params.marketId;
  fundingRateUpdateEntity.fundingRate = event.params.currentFundingRate;

  if (marketEntity) {
    fundingRateUpdateEntity.marketSymbol = marketEntity.marketSymbol;
    fundingRateUpdateEntity.marketName = marketEntity.marketName;
    updateFundingRatePeriods(event.block.timestamp, marketEntity.marketSymbol, fundingRateUpdateEntity);

    marketEntity.lastPrice = price;
    marketEntity.interestRate = event.params.currentFundingRate;
    marketEntity.save();
  }

  fundingRateUpdateEntity.save();
}

export function handlePermissionGranted(event: PermissionGrantedEvent): void {
  if (event.params.permission.toHex().startsWith(strToBytes('PERPS_COMMIT_ASYNC_ORDER').toHex())) {
    let id = event.params.accountId.toHex().concat('-').concat(event.params.user.toHex());
    let entity = DelegatedAccount.load(id);

    if (entity == null) {
      entity = new DelegatedAccount(id);
    }

    entity.caller = event.params.sender;
    entity.delegate = event.params.user;
    entity.blockNumber = event.block.number;
    entity.blockTimestamp = event.block.timestamp;
    entity.transactionHash = event.transaction.hash;

    entity.save();
  }
}

export function handlePermissionRevoked(event: PermissionRevokedEvent): void {
  if (event.params.permission.toHex().startsWith(strToBytes('PERPS_COMMIT_ASYNC_ORDER').toHex())) {
    let id = event.params.accountId.toHex().concat('-').concat(event.params.user.toHex());
    let entity = DelegatedAccount.load(id);

    if (entity != null) {
      store.remove('DelegatedAccount', id);
    }
  }
}

function updateFundingRatePeriods(timestamp: BigInt, asset: string, rate: FundingRateUpdate): void {
  for (let p = 0; p < FUNDING_RATE_PERIODS.length; p++) {
    let periodSeconds = FUNDING_RATE_PERIODS[p];
    let periodType = FUNDING_RATE_PERIOD_TYPES[p];
    let periodId = getTimeID(timestamp, periodSeconds);

    let id = asset + '-' + periodType + '-' + periodId.toString();

    let existingPeriod = FundingRatePeriod.load(id);

    if (existingPeriod == null) {
      let newPeriod = new FundingRatePeriod(id);
      newPeriod.fundingRate = rate.fundingRate;
      newPeriod.marketSymbol = rate.marketSymbol;
      newPeriod.marketName = rate.marketName;
      newPeriod.period = periodType;
      newPeriod.timestamp = timestamp.minus(timestamp.mod(periodSeconds));
      newPeriod.save();
    } else {
      existingPeriod.fundingRate = rate.fundingRate;
      existingPeriod.save();
    }
  }
}

export function handleCollateralModified(event: CollateralModifiedEvent): void {
  const accountId = event.params.accountId;
  const account = Account.load(accountId.toString());
  if (account !== null) {
    let collateralChange = new CollateralChange(accountId.toString());
    collateralChange.synthId = event.params.synthMarketId;
    collateralChange.accountId = accountId;
    collateralChange.sender = event.params.sender;
    collateralChange.timestamp = event.block.timestamp;
    collateralChange.amountDelta = event.params.amountDelta;
    collateralChange.txHash = event.transaction.hash.toHex();
    collateralChange.save();
  }

}

export function handleOrderCommitted(event: OrderCommittedEvent): void {
  const orderCommittedId = event.params.accountId.toString() + '-' + event.block.timestamp.toString();
  const pendingOrderId = event.params.accountId.toString() + '-' + event.params.marketId.toString();
  const pendingOrder = new PendingOrder(pendingOrderId);
  const orderCommitted = new OrderCommitted(orderCommittedId);
  pendingOrder.orderCommittedId = orderCommitted.id;
  pendingOrder.save();

 let volume = event.params.sizeDelta.abs().times(event.params.acceptablePrice).div(ETHER).abs();
 const accountBalance = CollateralChange.load(event.params.accountId.toString())
  orderCommitted.marketId = event.params.marketId;
  orderCommitted.accountId = event.params.accountId;
  orderCommitted.account = event.params.accountId.toString();
  orderCommitted.orderType = event.params.orderType;
  orderCommitted.sizeDelta = event.params.sizeDelta;
  orderCommitted.acceptablePrice = event.params.acceptablePrice;
  orderCommitted.commitmentTime = event.params.commitmentTime;
  orderCommitted.expectedPriceTime = event.params.expectedPriceTime;
  orderCommitted.settlementTime = event.params.settlementTime;
  orderCommitted.expirationTime = event.params.expirationTime;
  orderCommitted.trackingCode = event.params.trackingCode;
  orderCommitted.sender = event.params.sender;
  orderCommitted.txnHash = event.transaction.hash.toHex();
  orderCommitted.timestamp = event.block.timestamp;
  orderCommitted.collateral =  accountBalance ?  accountBalance.amountDelta || new BigInt(0)   :  new BigInt(0)
  orderCommitted.status = 'PENDING'
  orderCommitted.save();
}

export function handleInterestCharged(event: InterestChargedEvent): void {
  const accountId = event.params.accountId;
  const account = Account.load(accountId.toString());

  if (account !== null) {
    let interestCharged = new InterestCharged(accountId.toString() + '-' + event.transaction.hash.toHex());

    interestCharged.accountId = accountId;
    interestCharged.timestamp = event.block.timestamp;
    interestCharged.interest = event.params.interest;
    interestCharged.txHash = event.transaction.hash.toHex();
    interestCharged.block = event.block.number;
    log.info('Interest charged: {} {} {}', [
      interestCharged.interest.toString(),
      interestCharged.accountId.toString(),
      interestCharged.block.toString(),
    ]);
    interestCharged.save();
  }
}

function calculatePnl(
  position: PerpsV3Position,
  order: OrderSettled,
  event: OrderSettledEvent,
  statEntity: PerpsV3Stat,
): void {
  let pnl = event.params.fillPrice
    .minus(position.avgEntryPrice)
    .times(event.params.sizeDelta.abs())
    .times(position.size.gt(ZERO) ? BigInt.fromI32(1) : BigInt.fromI32(-1))
    .div(ETHER);
  let interestCharged = ZERO;
  if (order.interestCharged !== null) {
    interestCharged = order.interestCharged!;
  }
  position.interestCharged = position.interestCharged.plus(interestCharged);
  position.realizedPnl = position.realizedPnl.plus(pnl);
  position.pnlWithFeesPaid = position.realizedPnl
    .minus(position.feesPaid)
    .plus(position.netFunding)
    .plus(interestCharged);
  order.pnl = order.pnl.plus(pnl);
  statEntity.pnl = statEntity.pnl.plus(pnl);
  statEntity.pnlWithFeesPaid = statEntity.pnlWithFeesPaid
    .plus(pnl)
    .minus(order.totalFees)
    .plus(order.accruedFunding)
    .plus(interestCharged);
  let pnlSnapshot = new PnlSnapshot(
    position.id + '-' + event.block.timestamp.toString() + '-' + event.transaction.hash.toHex(),
  );
  pnlSnapshot.pnl = statEntity.pnl;
  pnlSnapshot.accountId = position.accountId;
  pnlSnapshot.timestamp = event.block.timestamp;
  pnlSnapshot.save();
  order.save();
  position.save();
  statEntity.save();
}

function getOrCreateMarketAggregateStats(
  marketId: BigInt,
  marketSymbol: string,
  timestamp: BigInt,
  period: BigInt,
): PerpsV3AggregateStat {
  // helper function for creating a market aggregate entity if one doesn't exist
  // this allows functions to safely call this function without checking for null
  const id = `${timestamp.toString()}-${period.toString()}-${marketSymbol}`;
  let aggregateEntity = PerpsV3AggregateStat.load(id);
  if (aggregateEntity == null) {
    aggregateEntity = new PerpsV3AggregateStat(id);
    aggregateEntity.period = period;
    aggregateEntity.timestamp = timestamp;
    aggregateEntity.marketId = marketId;
    aggregateEntity.marketSymbol = marketSymbol;
    aggregateEntity.trades = ZERO;
    aggregateEntity.volume = ZERO;
  }
  return aggregateEntity as PerpsV3AggregateStat;
}

export function updateAggregateStatEntities(
  marketId: BigInt,
  marketSymbol: string,
  timestamp: BigInt,
  trades: BigInt,
  volume: BigInt,
): void {
  // this function updates the aggregate stat entities for the specified account and market
  // it is called when users interact with positions or when positions are liquidated
  // to add new aggregate periods, update the `AGG_PERIODS` array in `constants.ts`
  // new aggregates will be created for any resolution present in the array
  for (let period = 0; period < AGG_PERIODS.length; period++) {
    const thisPeriod = AGG_PERIODS[period];
    const aggTimestamp = getTimeID(timestamp, thisPeriod);

    // update the aggregate for this market
    let aggStats = getOrCreateMarketAggregateStats(marketId, marketSymbol, aggTimestamp, thisPeriod);
    aggStats.trades = aggStats.trades.plus(trades);
    aggStats.volume = aggStats.volume.plus(volume);
    aggStats.save();

    // update the aggregate for all markets
    let aggCumulativeStats = getOrCreateMarketAggregateStats(new BigInt(0), 'ALL', aggTimestamp, thisPeriod);
    aggCumulativeStats.trades = aggCumulativeStats.trades.plus(trades);
    aggCumulativeStats.volume = aggCumulativeStats.volume.plus(volume);
    aggCumulativeStats.save();
  }
}

export function handlePreviousOrderExpired(event: PreviousOrderExpiredEvent): void {
  const orderExpiredId =
    event.params.marketId.toString() +
    '-' +
    event.params.accountId.toString() +
    '-' +
    event.block.number.toString();
    const pendingOrderId = event.params.accountId.toString() + '-' + event.params.marketId.toString();
    const pendingOrder = PendingOrder.load(pendingOrderId);
    if (pendingOrder !== null) {
       const orderCommitted =  OrderCommitted.load(pendingOrder.orderCommittedId);
       if(orderCommitted){
          orderCommitted.status = 'EXPIRED'
         orderCommitted.save()
       }
    }
  const accountBalance = CollateralChange.load(event.params.accountId.toString())
  let orderExpired = new PreviousOrderExpired(orderExpiredId);
  orderExpired.timestamp = event.block.timestamp;
  orderExpired.collateral = accountBalance ? accountBalance.amountDelta || new BigInt(0) : new BigInt(0)
  orderExpired.marketId = event.params.marketId;
  orderExpired.accountId = event.params.accountId;
  orderExpired.sizeDelta = event.params.sizeDelta;
  orderExpired.acceptablePrice = event.params.acceptablePrice;
  orderExpired.commitmentTime = event.params.commitmentTime;
  orderExpired.txnHash =  event.transaction.hash.toHex();
  orderExpired.trackingCode =event.params.trackingCode
  orderExpired.save();
}
