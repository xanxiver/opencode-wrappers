# Domain glossary

## Durable job

A durable job is one accepted user request that remains recoverable until its
result reaches a terminal state.

## Job owner

A job owner is the execution stream that supplies jobs. Only one job for an
owner can execute at a time. Prompts that target the same session have the same
owner.

## Source key

A source key is the stable identity of an incoming request. Repeated delivery
of the same source key refers to the same durable job.

## Lease

A lease is temporary permission for one worker to advance a durable job. A
lease generation prevents an old worker from changing a reclaimed job.

## Finalization

Finalization is the delivery of a completed job result to its user. A job is
complete only after finalization succeeds.

## Reconciliation

Reconciliation determines whether an external operation succeeded when its
local result is not known. Reconciliation must not repeat an operation until
the prior outcome is known.
