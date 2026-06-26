# TradeFlow Security Notes

This document records the main security and control checks performed for the TradeFlow MVP.

TradeFlow is a student portfolio prototype, not production banking software. The security work focuses on demonstrating disciplined engineering around smart-contract controls that are relevant to banking operations and technology-risk roles.

## Tooling

### Hardhat Tests

Command:

```bash
npm test
```

Current result:

```text
23 passing
```

The test suite covers:

- normal workflow from deal creation to payment release
- access-control failures
- compliance/credit role exclusivity
- invalid state transitions
- parameterised state-function matrix testing
- revision, rejection, freeze, and expiry paths
- duplicate invoice hash prevention
- finite MockUSD liquidity pool failure
- pause/unpause behavior
- payment release safety and reentrancy-oriented testing

### Slither

Command used:

```powershell
& "C:\Users\DELL\AppData\Roaming\Python\Python314\Scripts\slither.exe" . --filter-paths "contracts/test|node_modules"
```

Full output is saved in:

```text
security/slither-report.txt
```

Result summary:

```text
Analyzed 22 contracts with 101 detectors.
3 result(s) found.
```

All reported findings are from Slither's `timestamp` detector:

- `createDeal` compares `expiryDeadline` with `block.timestamp`
- `markExpired` compares `block.timestamp` with `deal.expiryDeadline`
- `_expireIfNeeded` compares `block.timestamp` with `deal.expiryDeadline`

Decision:

Accepted with documentation.

Reason:

TradeFlow uses timestamps only for business deadline checks, not randomness, price setting, lottery selection, or miner/proposer reward extraction. Minor timestamp drift is acceptable for this MVP because expiry is a workflow deadline, not a value-critical oracle. Boundary behavior is covered by unit tests: exactly at the deadline is not expired, and one second after the deadline is expired.

Production note:

A production banking workflow could use wider operational grace periods, off-chain scheduler/oracle services, or block-number-based deadlines depending on policy. Those are out of scope for this MVP.

## Key Controls

### Admin And Deployment Assumption

The Sepolia demo uses a dedicated deployer/admin wallet to deploy contracts, seed MockUSD liquidity, and grant demo roles. This is acceptable for a portfolio prototype, but it is a centralised administration assumption rather than a production bank governance model. A production deployment would require controlled key custody, change management, and likely multi-party approval for role administration and emergency pause actions.

### Segregation Of Duties

The same address cannot hold both `COMPLIANCE_ROLE` and `CREDIT_ROLE`.

This is enforced at role-grant time, not delayed until a business function is called. The relevant tests attempt both conflicting grants and expect `RoleConflict`.

### State Machine Enforcement

Each workflow function checks the current deal status before changing state.

The test suite includes a parameterised matrix across states and functions. The valid transitions succeed, and invalid state-function combinations revert.

Current matrix coverage:

```text
10 valid combinations
80 invalid combinations
```

This demonstrates that the workflow is controlled systematically rather than only through ad hoc tests.

### Duplicate Invoice Prevention

`invoiceHashToDealId` prevents the same invoice hash from being financed twice.

This models a real trade finance fraud risk: duplicate financing of the same invoice. The MVP uses a strict rule that an invoice hash cannot be reused once submitted.

### Finite Liquidity Pool

`fundDeal` checks `availableLiquidity()` before reserving MockUSD.

The contract does not mint funds during workflow execution. The finite MockUSD pool is seeded before funding, and insufficient liquidity causes `InsufficientLiquidity`.

### Payment Release Safety

`releasePayment` uses:

- `onlyRole(TREASURY_ROLE)`
- strict `Funded` status requirement
- checks-effects-interactions ordering
- `nonReentrant`
- `SafeERC20`

The test suite includes a malicious token and malicious exporter/treasury contract. During token transfer, the malicious receiver attempts to re-enter `releasePayment` for a second funded deal. The attempt is blocked and the second deal remains `Funded`.

This test is intentionally stronger than a simple "call twice" test: it exercises a nested call during the external token transfer.

### Pausable Global Control

`Pausable` is contract-level operational control. It differs from deal-level `Frozen`:

- `Frozen`: one deal has a compliance-risk issue.
- `Pausable`: the whole system is stopped for incident response, operational risk, or regulatory instruction.

Tests verify that paused state blocks workflow actions and that unpause restores normal valid operations.

## Known Limitations

The MVP does not model:

- buyer repayment
- default handling
- credit scoring
- real sanctions/KYC/AML provider integration
- private document storage
- production privacy architecture
- multi-bank settlement
- partial repayments or drawdowns
- formal dispute resolution
- unfreezing governance

These limitations are intentional scope boundaries. The MVP is designed to show operational and compliance controls, not the full credit-risk lifecycle of invoice financing.
