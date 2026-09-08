# Stem Splitter fleet integration design

The bounded design and rollout contract are in
[the fleet integration proposal](../fleet-integration.md).

The model-use boundary is class code plus two independently verified same-person
CAIL identity tokens. Shared class resources and the separate teacher credential
boundary retain their current meanings. Listening Guy alone delegates model
transport, policy and accounting to Gateway. Replicate and YouTube remain outside
that accounting boundary. There is no schema or ownership migration.

The active Node adapter accepts the proposed prefix alongside the legacy root
origin. Deployment and mount activation are later, CI-only actions requiring
receiver verification and preservation checks of published URLs.
