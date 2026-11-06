# Classic V2 account terminal

Two views share the existing OpenTrader service and admin password.

- Original dashboard at /
- Six-agent terminal at /terminal/index.html

The terminal reads current BTC and SOL perpetual prices and closed hourly
Bollinger 20/2 and RSI 14 values. Account equity, available USDT and positions
come from Bitget Classic V2 when read-only credentials are configured.
It has no order submission endpoint. The Sizer and Executor panels display
their inactive state. The existing BB/RSI backtest is included in the build.

## GitHub release

The Build Classic Terminal workflow tests the account read boundary and
protected terminal route, builds OpenTrader, and produces the
classic-terminal-release artifact. Deploy the artifact onto the existing
opentrader-custom:bb-rsi image so the pinned dependencies and database layout
match the running installation. Preserve the existing container configuration,
private network and data volume, and retain the previous container for rollback.

The public market monitor runs separately with internet access, no published
ports, and access to a dedicated terminal state volume. Only the OpenTrader
container serves that state, through its authenticated GET endpoint.
Each snapshot replaces the previous one atomically.

## Read-only account connection

Create a Classic API key with read-only permissions and store these variables
in a file owned by the server administrator with mode 600.

    BITGET_API_KEY=...
    BITGET_SECRET_KEY=...
    BITGET_PASSPHRASE=...

Pass that file only to the market monitor container with --env-file.
Do not commit it or put the values into chat. Restart the monitor to load it.
The monitor uses the real Classic V2 account endpoints. There is no demo header.

Without credentials, market prices and indicators work and account panels
show Account not connected. On API failures, account values become unavailable.
The page labels snapshots older than 150 seconds as stale. The browser holds
the admin password in memory and clears displayed account data on disconnect.

## aggr.trade

An external link opens aggr.trade separately. This release has no embedded
aggr client or data ingestion. Its live trades and liquidation feeds can be
explored independently. Historical aggr charts need an additional data source.
