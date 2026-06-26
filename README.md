# TradeFlow

TradeFlow is an audit-aware SME invoice financing workflow DApp built with Solidity and Hardhat.

It is a portfolio project for banking trade finance, operations, and technology-risk roles. The project demonstrates how smart contracts can enforce operational controls such as segregation of duties, approval sequencing, audit events, duplicate invoice checks, expiry handling, and finite MockUSD liquidity.

TradeFlow is not a production banking system and not a full letter of credit platform. It deliberately focuses on the operational and compliance control layer of invoice financing.

## Business Scenario

An SME exporter applies for financing against an invoice owed by an importer. The workflow is:

1. Exporter creates a financing application.
2. Exporter submits invoice and trade document hashes.
3. Compliance officer reviews KYC/AML risk.
4. Credit officer approves only after compliance has passed.
5. Treasury funds the deal from a pre-funded MockUSD pool.
6. Treasury releases simulated financing proceeds to the exporter.

Raw documents and sensitive customer data are not stored on-chain. The contract stores hashes only, which supports tamper evidence while respecting data-minimisation principles.

## Main Controls

- Multi-deal architecture: one contract manages many financing applications.
- Segregation of duties: one address cannot hold both compliance and credit approval roles.
- State machine: functions enforce valid workflow transitions.
- Exception paths: revision, rejection, freeze, expiry, and pause are handled explicitly.
- Deal-level Frozen state is separate from contract-level Pausable emergency control.
- Duplicate invoice hash prevention models duplicate-financing fraud risk.
- Invoice hashes are permanently locked on first use regardless of trade outcome.
- MockUSD ERC20 simulates tokenised cash settlement instead of using native ETH.
- Finite liquidity pool: funding fails if the contract does not hold enough MockUSD.
- Audit trail: all material state changes emit events.

## Role Permission Matrix

| Role | Functions | Permitted | Notes |
| --- | --- | --- | --- |
| Exporter | `createDeal`, `submitDocuments` | Yes, for its own deals | Starts the SME financing request and submits hash-only document evidence |
| `COMPLIANCE_ROLE` | `passCompliance`, `requestRevision`, `freezeDeal`, `rejectAtCompliance` | Yes | Maps to KYC/AML sign-off and compliance exception handling |
| `CREDIT_ROLE` | `approveCredit`, `rejectAtCredit` | Yes, after compliance passes | Maps to senior credit approval and credit-stage rejection |
| `TREASURY_ROLE` | `fundDeal`, `releasePayment` | Yes, after credit approval/funding | Reserves and releases MockUSD from the finite liquidity pool |
| `DEFAULT_ADMIN_ROLE` | `grantRole`, `revokeRole`, `pause`, `unpause` | Yes | Manages bank roles and contract-level emergency control |
| Importer | Workflow functions | No | Recorded as invoice counterparty; buyer repayment is future work |

The same address cannot hold both `COMPLIANCE_ROLE` and `CREDIT_ROLE`, so one account cannot both clear compliance risk and approve financing.

## State Machine

```text
Created -> DocumentsSubmitted

DocumentsSubmitted -> RevisionRequested
RevisionRequested -> DocumentsSubmitted

DocumentsSubmitted -> CompliancePassed
DocumentsSubmitted -> Frozen
DocumentsSubmitted -> Rejected

CompliancePassed -> CreditApproved
CompliancePassed -> Rejected

CreditApproved -> Funded

Funded -> PaymentReleased

Created -> Expired
DocumentsSubmitted -> Expired
RevisionRequested -> Expired
CompliancePassed -> Expired
CreditApproved -> Expired
```

Terminal states:

```text
PaymentReleased
Rejected
Frozen
Expired
```

Frozen is terminal in the MVP. In a real bank, unfreezing a sanctions or AML-risk case would require manual investigation and additional governance controls.

Expiry is the funding-window deadline for reaching the funded stage; it does not represent the underlying invoice maturity or buyer payment due date.

## Project Structure

```text
contracts/
  MockUSD.sol
  TradeFlow.sol
docs/
  specification.md
scripts/
  deploy-sepolia.js
test/
  TradeFlow.test.js
```

## Setup

```bash
npm install
npm run compile
npm test
```

## Local Frontend Demo

Install frontend dependencies:

```bash
cd frontend
npm install
cd ..
```

Start a local Hardhat chain:

```bash
npx hardhat node --hostname 127.0.0.1
```

In another terminal, deploy the contracts and generate the frontend deployment config:

```bash
npm run deploy:localhost
```

Then start the React demo:

```bash
npm run frontend:dev
```

Open the Vite URL, normally:

```text
http://127.0.0.1:5173/
```

For the local demo, import or use the Hardhat test accounts printed by `npx hardhat node`. The demo role addresses are also written to:

```text
frontend/src/contracts/deployment.json
```

The most useful demo path is:

1. connect as exporter and create a deal
2. submit invoice/document hashes
3. switch to compliance and pass, reject, freeze, or request revision
4. switch to credit and approve/reject
5. switch to treasury and fund/release
6. deliberately use the wrong role to show that the smart contract blocks the action

## Sepolia Deployment

Create a `.env` file:

```bash
SEPOLIA_RPC_URL=https://sepolia.infura.io/v3/YOUR_KEY
PRIVATE_KEY=0xYOUR_PRIVATE_KEY_WITH_SEPOLIA_ETH
```

Deploy:

```bash
npm run deploy:sepolia
```

See [docs/sepolia-deployment.md](docs/sepolia-deployment.md) for the full testnet deployment guide and private-key safety notes.

The deployment script:

1. deploys `MockUSD`
2. deploys `TradeFlow`
3. mints MockUSD to the deployer
4. transfers the initial MockUSD liquidity pool into `TradeFlow`
5. grants the deployer `TREASURY_ROLE`

For a real demo, grant `COMPLIANCE_ROLE`, `CREDIT_ROLE`, and `TREASURY_ROLE` to separate addresses to demonstrate segregation of duties.

MockUSD is a test token for Sepolia and local demos. A production settlement design would need a regulated stablecoin, tokenised deposit, CBDC-style rail, or another approved bank settlement layer.

## Test Coverage Focus

The tests cover:

- normal workflow from deal creation to payment release
- role-based access control failures
- compliance/credit role exclusivity
- invalid state transitions, including a parameterised state-function matrix
- revision and resubmission loop
- compliance rejection, deal freeze, and credit rejection
- duplicate invoice hash prevention
- finite liquidity pool failure
- expiry boundary behavior
- pause/unpause behavior
- duplicate payment release prevention
- reentrancy-oriented payment safety using test-only malicious contracts

## Demo Evidence

The Sepolia demo was exercised through both a happy path and a negative control path.

Positive path:

```text
Created -> DocumentsSubmitted -> CompliancePassed -> CreditApproved -> Funded -> PaymentReleased
```

The final deal dashboard shows `PaymentReleased`, `8,000 mUSD financed`, the exporter/importer addresses, and the invoice/document hashes stored on-chain.

Negative path:

```text
Create duplicate deal -> submit already-used invoice hash -> DuplicateInvoiceHash revert
```

The frontend displays:

```text
Duplicate invoice check: Duplicate invoice blocked: hash already belongs to deal 1.
```

This demonstrates a trade-finance-specific fraud control: the same invoice hash cannot be used to obtain financing twice.
Invoice hashes are permanently locked on first use regardless of trade outcome.

## Security Notes

See [SECURITY.md](SECURITY.md) for Slither results and the security/control testing rationale.

The current Hardhat suite includes 23 passing tests. Slither reports only timestamp-related findings, which are accepted because timestamps are used for workflow deadline checks rather than randomness or value-critical price logic.

## Scope Boundary

The MVP does not model:

- buyer repayment
- default handling
- credit scoring
- real KYC/AML provider integration
- sanctions oracle
- real document storage
- partial drawdowns or repayments
- interest accrual
- multi-bank syndication
- multi-currency settlement
- full letter of credit workflow

Future work could extend the state machine with:

```text
PaymentReleased -> RepaymentPending
RepaymentPending -> RepaymentReceived
RepaymentPending -> Defaulted
```

## CV Description

Built TradeFlow, a Solidity and Hardhat-based SME invoice financing workflow DApp for Ethereum Sepolia. Designed role-separated compliance, credit, and treasury controls using OpenZeppelin AccessControl; implemented a state-machine-driven approval process, hash-only document verification, duplicate invoice prevention, audit events, expiry handling, and MockUSD-based disbursement from a finite liquidity pool. Wrote unit tests for normal flows, permission failures, invalid transitions, expiry boundaries, funding failures, and payment safety.
