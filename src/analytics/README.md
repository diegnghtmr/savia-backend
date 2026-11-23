# Analytics

Cash-flow buckets use UTC calendar boundaries. `from` and `to` are inclusive UTC
calendar dates; an edge bucket contains only movements falling within those
bounds, with no extrapolation. Its response shape does not expose a partial
flag. Advanced metrics disclose clipped periods and incomplete inputs separately.

Repeated query parameters encode ID arrays. Transactions match any ID within a
filter and all supplied filter dimensions. `memberIds` are workspace membership
IDs; on a booking they select its creator. Account valuations take account
filters, not transaction classifications. Where a schedule has no booking or
other metadata to match, it is not selected by filters on that metadata.

Booked analytics use exchange rates effective at the relevant instant. A
cash-flow request with a missing pair returns a problem; advanced metrics report
missing inputs and omit affected points where the response cannot express a
null amount. Historic net worth uses recorded balances at UTC month ends or the
requested cut (no later than the current instant); FX movement revalues the
previous cut's native positions without counting intervening transactions as
valuation changes.

`fxRatesUsed` lists the distinct rates applied to cross-currency amounts in a
result, with exact decimal strings, UTC effective dates, sources, and freshness
at valuation time. Analytics and report runs omit the field when they use no
conversion. Completed report runs retain the rate list stored with the snapshot.

Actual recurrence requires a persisted association, not a payee-name guess.
Calendar expectations use recorded next dates and exclude actual bookings and
reminders. Annual subscription costs and debt payoff outlooks are estimates,
not observations. See each advanced response's `assumptions` and `missingData`.
