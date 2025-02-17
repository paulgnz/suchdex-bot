// Interactions with the DEX contract, via RPC
import { JsonRpc, Api, JsSignatureProvider, Serialize } from '@proton/js';
import { BigNumber } from 'bignumber.js';
import { FILLTYPES, ORDERSIDES, ORDERTYPES } from './core/constants';
import * as dexapi from './dexapi';
import { getConfig, getLogger, getUsername } from './utils';

type OrderAction = Serialize.Action

const logger = getLogger();

const config = getConfig();
const { endpoints, privateKey, privateKeyPermission } = config.rpc;
const username = getUsername();

let signatureProvider = process.env.npm_lifecycle_event === 'test'? undefined : new JsSignatureProvider([privateKey]);
let actions: OrderAction[] = [];

// Initialize
const rpc = new JsonRpc(endpoints);
const api = new Api({
  rpc,
  signatureProvider
});

const apiTransact = (actions: Serialize.Action[] ) => api.transact({ actions }, {
  blocksBehind: 300,
  expireSeconds: 3000,
});

const authorization = [{
  actor: username,
  permission: privateKeyPermission,
}];

/**
 * Given a list of on-chain actions, apply authorization and send
 */
const transact = async (actions: OrderAction[]) => {
  // apply authorization to each action
  const authorization = [{
    actor: username,
    permission: privateKeyPermission,
  }];
  const authorizedActions = actions.map((action) => ({ ...action, authorization }));
  await apiTransact(authorizedActions);
};

/**
 * Place a buy or sell limit order. Quantity and price are string values to
 * avoid loss of precision when placing order
 */
export const prepareLimitOrder = async (marketSymbol: string, orderSide: ORDERSIDES, quantity: BigNumber.Value, price: number): Promise<void> => {
  const market = dexapi.getMarketBySymbol(marketSymbol);
  if(!market) {
    throw new Error(`No market found by symbol ${marketSymbol}`);
  }
  const askToken = market.ask_token;
  const bidToken = market.bid_token;

  const bnQuantity = new BigNumber(quantity);
  const quantityText = orderSide === ORDERSIDES.SELL
    ? `${bnQuantity.toFixed(bidToken.precision)} ${bidToken.code}`
    : `${bnQuantity.toFixed(askToken.precision)} ${askToken.code}`;

  const orderSideText = orderSide === ORDERSIDES.SELL ? 'sell' : 'buy';
  logger.info(`Placing ${orderSideText} order for ${quantityText} at ${price}`);

  const quantityNormalized = orderSide === ORDERSIDES.SELL
    ? (bnQuantity.times(bidToken.multiplier)).toString()
    : (bnQuantity.times(askToken.multiplier)).toString();

  const cPrice = new BigNumber(price);
  const priceNormalized = cPrice.multipliedBy(askToken.multiplier);

  actions.push(
    {
      account: orderSide === ORDERSIDES.SELL ? bidToken.contract : askToken.contract,
      name: 'transfer',
      data: {
        from: username,
        to: 'dex',
        quantity: quantityText,
        memo: '',
      },
      authorization,
    },
    {
      account: 'dex',
      name: 'placeorder',
      data: {
        market_id: market.market_id,
        account: username,
        order_type: ORDERTYPES.LIMIT,
        order_side: orderSide,
        quantity: quantityNormalized,
        price: priceNormalized,
        bid_symbol: {
          sym: `${bidToken.precision},${bidToken.code}`,
          contract: bidToken.contract,
        },
        ask_symbol: {
          sym: `${askToken.precision},${askToken.code}`,
          contract: askToken.contract,
        },
        trigger_price: 0,
        fill_type: FILLTYPES.POST_ONLY,
        referrer: '',
      },
      authorization,
    },
  );
};

export const submitOrders = async (): Promise<void> => {
  actions.push(
  {
    account: 'dex',
    name: 'process',
    data: {
      q_size: 60,
      show_error_msg: 0,
    },
    authorization,
  },
  {
    account: 'dex',
    name: "withdrawall",
    data: {
        account: username,
    },
    authorization,
  },);

  const response = await apiTransact(actions);
  actions = [];
}

export const submitProcessAction = async (): Promise<void> => {
  const processAction = [({
    account: 'dex',
    name: 'process',
    data: {
      q_size: 100,
      show_error_msg: 0,
    },
    authorization,
  })];

  const response = apiTransact(processAction);
}

const createCancelAction = (orderId: string | number): OrderAction => ({
  account: 'dex',
  name: 'cancelorder',
  data: {
    account: username,
    order_id: orderId,
  },
  authorization,
});

const withdrawAction = () => ({
  account: 'dex',
  name: "withdrawall",
  data: {
      account: username,
  },
  authorization,
});


/**
 * Cancel a single order
 */
export const cancelOrder = async (orderId: string): Promise<void> => {
  logger.info(`Canceling order with id: ${orderId}`);
  const response = await transact([createCancelAction(orderId)]);
  return response;
};

/**
 * Cancel all orders for the current account
 */
export const cancelAllOrders = async (): Promise<void> => {
  try {
    let cancelList = [];
    let i = 0;
    while(true) {
      const ordersList = await dexapi.fetchOpenOrders(username, 150, 150 * i);
      if(!ordersList.length) break;
      cancelList.push(...ordersList);
      i++;
    }
    if(!cancelList.length) {
      console.log(`No orders to cancel`);
      return;
    }
    console.log(`Cancelling all (${cancelList.length}) orders`);
    const actions = cancelList.map((order) => createCancelAction(order.order_id));
    const response = await transact(actions);
    return response;
  }
  catch (e) {
    console.log('cancel orders error', e)
    return undefined
  }
};
