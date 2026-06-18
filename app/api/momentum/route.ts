export const runtime = "nodejs";
export const maxDuration = 60;

type PricePoint = {
  time: string;
  price: number;
};

function parseArray(value: any): any[] {
  if (Array.isArray(value)) return value;
  if (typeof value === "string") {
    try { return JSON.parse(value); } catch { return []; }
  }
  return [];
}

async function getTokenId(marketUrl: string, outcome: string): Promise<string | null> {
  try {
    const urlPath = marketUrl.replace("https://polymarket.com/event/", "");
    const slug = urlPath.split("/")[0];
    const res = await fetch("https://gamma-api.polymarket.com/events?slug=" + slug, {
      headers: { Accept: "application/json" },
      cache: "no-store",
    });
    if (!res.ok) return null;
    const data = await res.json();
    const events = Array.isArray(data) ? data : data?.events || data?.data || [];
    const event = events[0];
    if (!event) return null;
    const markets = Array.isArray(event?.markets) ? event.markets : [];
    const outcomeLower = outcome.toLowerCase();
    for (const market of markets) {
      const title = (market?.groupItemTitle || market?.shortTitle || market?.question || "").toLowerCase();
      if (title.includes(outcomeLower) || outcomeLower.includes(title)) {
        const tokenIds = parseArray(market?.clobTokenIds);
        if (tokenIds.length > 0) return String(tokenIds[0]);
      }
    }
    const firstWord = outcomeLower.split(" ")[0];
    for (const market of markets) {
      const title = (market?.groupItemTitle || market?.shortTitle || market?.question || "").toLowerCase();
      if (title.includes(firstWord)) {
        const tokenIds = parseArray(market?.clobTokenIds);
        if (tokenIds.length > 0) return String(tokenIds[0]);
      }
    }
    return null;
  } catch { return null; }
}

async function getHistoryByToken(tokenId: string): Promise<PricePoint[]> {
  const apiKey = process.env.BITQUERY_API_KEY;
  if (!apiKey) return [];
  const after = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString().split(".")[0] + "Z";
  const query = `{
    EVM(network: matic) {
      PredictionTrades(
        limit: {count: 500}
        orderBy: {ascending: Block_Time}
        where: {
          TransactionStatus: {Success: true}
          Block: {Time: {after: "${after}"}}
          Trade: {
            Prediction: {
              OutcomeToken: {
                AssetId: {is: "${tokenId}"}
              }
            }
          }
        }
      ) {
        Block { Time }
        Trade { OutcomeTrade { Price } }
      }
    }
  }`;
  try {
    const res = await fetch("https://streaming.bitquery.io/graphql", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ query }),
      cache: "no-store",
    });
    if (!res.ok) return [];
    const data = await res.json();
    const trades = data?.data?.EVM?.PredictionTrades || [];
    return trades
      .filter((t: any) => { const p = t.Trade?.OutcomeTrade?.Price; return p !== undefined && p >= 0.005 && p <= 0.995; })
      .map((t: any) => ({ time: t.Block.Time, price: Math.round(t.Trade.OutcomeTrade.Price * 10000) / 100 }));
  } catch { return []; }
}

async function getHistoryByTitle(marketTitle: string): Promise<PricePoint[]> {
  const apiKey = process.env.BITQUERY_API_KEY;
  if (!apiKey) return [];
  const after = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString().split(".")[0] + "Z";
  const query = `{
    EVM(network: matic) {
      PredictionTrades(
        limit: {count: 500}
        orderBy: {ascending: Block_Time}
        where: {
          TransactionStatus: {Success: true}
          Block: {Time: {after: "${after}"}}
          Trade: {
            Prediction: {
              Question: {
                Title: {includes: "${marketTitle}"}
              }
            }
          }
        }
      ) {
        Block { Time }
        Trade { OutcomeTrade { Price } }
      }
    }
  }`;
  try {
    const res = await fetch("https://streaming.bitquery.io/graphql", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ query }),
      cache: "no-store",
    });
    if (!res.ok) return [];
    const data = await res.json();
    const trades = data?.data?.EVM?.PredictionTrades || [];
    return trades
      .filter((t: any) => { const p = t.Trade?.OutcomeTrade?.Price; return p !== undefined && p >= 0.005 && p <= 0.50; })
      .map((t: any) => ({ time: t.Block.Time, price: Math.round(t.Trade.OutcomeTrade.Price * 10000) / 100 }));
  } catch { return []; }
}

function calcMomentum(points: PricePoint[]) {
  if (points.length === 0) return { price_1d_ago: null, price_7d_ago: null, data_points: [] };
  const sorted = points.sort((a, b) => new Date(a.time).getTime() - new Date(b.time).getTime());
  const oneDayAgo = Date.now() - 24 * 60 * 60 * 1000;
  const price_7d_ago = sorted[0].price;
  const near1d = sorted.filter(p => new Date(p.time).getTime() <= oneDayAgo).slice(-1)[0];
  const price_1d_ago = near1d?.price ?? null;
  const step = Math.max(1, Math.floor(sorted.length / 20));
  const data_points = sorted.filter((_: any, i: number) => i % step === 0);
  return { price_1d_ago, price_7d_ago, data_points };
}

export async function POST(req: Request) {
  try {
    let body: any = {};
    try { body = await req.json(); } catch {
      return Response.json({ price_1d_ago: null, price_7d_ago: null, data_points: [] });
    }
    const market_url = String(body?.market_url || "").trim();
    const outcome = String(body?.outcome || "").trim();
    const market_title = String(body?.market_title || "").trim();

    if (market_url && outcome) {
      const tokenId = await getTokenId(market_url, outcome);
      if (tokenId) {
        const points = await getHistoryByToken(tokenId);
        if (points.length > 0) return Response.json(calcMomentum(points));
      }
    }

    const titleToSearch = market_title || outcome;
    if (titleToSearch) {
      const points = await getHistoryByTitle(titleToSearch);
      return Response.json(calcMomentum(points));
    }

    return Response.json({ price_1d_ago: null, price_7d_ago: null, data_points: [] });
  } catch {
    return Response.json({ price_1d_ago: null, price_7d_ago: null, data_points: [] });
  }
}
