# Keep prompt jobs durable through final delivery

The Telegram wrapper stores each accepted prompt as one durable job until its
final response reaches Telegram. Workers use renewable, generation-fenced
leases and reclaim the same job after a failure. The executor does not delete a
job when it starts, and it does not retry an uncertain OpenCode submission as a
new job. This design favors recoverable work and duplicate prevention over the
simpler memory-only active-run model.
