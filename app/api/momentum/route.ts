export const runtime = "nodejs";
export const maxDuration = 60;

type PricePoint = {
  time: string;
  price: number;
};

export async function POST(req: Request) {
  try {
    let body: any = {};
    try { body = await req.json(); } catch {
      return Response.json({ price_1d_ago: null, price_7d_ago: null, data_points: [] });
    }

    const market_title = String(body?.market_title || "").trim();
    if (!market_title) return Response.json({ price_1d_ago: null, price_7d_ago: null, data_points: [] });

    const apiKey = process.env.BITQUERY_API_KEY;
    if (!apiKey) return Response.json({ price_1d_ago: null, price_7d_ago: null, data_points: [] });

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
                  Title: {includes: "${market_title}"}
                }
              }
            }
          }
        ) {
          Block { Time }
          Trade {
            OutcomeTrade { Price }
          }
        }
      }
    }`;

    const res = await fetch("https://streaming.bitquery.io/graphql", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ query }),
      cache: "no-store",
    });

    if (!res.ok) return Response.json({ price_1d_ago: null, price_7d_ago: null, data_points: [] });

    const data = await res.json();
    const trades = data?.data?.EVM?.PredictionTrades || [];

    const filtered = trades.filter((t: any) => {
      const p = t.Trade?.OutcomeTrade?.Price;
      return p !== undefined && p >= 0.02 && p <= 0.50;
    });

    if (filtered.length === 0) return Response.json({ price_1d_ago: null, price_7d_ago: null, data_points: [] });

    const sorted: PricePoint[] = filtered
      .map((t: any) => ({ time: t.Block.Time, price: Math.round(t.Trade.OutcomeTrade.Price * 10000) / 100 }))
      .sort((a: PricePoint, b: PricePoint) => new Date(a.time).getTime() - new Date(b.time).getTime());

    const oneDayAgo = Date.now() - 24 * 60 * 60 * 1000;
    const price_7d_ago = sorted[0].price;
    const near1d = sorted.filter(p => new Date(p.time).getTime() <= oneDayAgo).slice(-1)[0];
    const price_1d_ago = near1d?.price ?? null;
    const step = Math.max(1, Math.floor(sorted.length / 20));
    const data_points = sorted.filter((_: any, i: number) => i % step === 0);

    return Response.json({ price_1d_ago, price_7d_ago, data_points });

  } catch {
    return Response.json({ price_1d_ago: null, price_7d_ago: null, data_points: [] });
  }
}
