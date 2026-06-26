# TradeFlow Project Specification

## 1. Project Overview

**Project name:** TradeFlow

**Working title:** Audit-aware SME Invoice Financing Workflow DApp

TradeFlow is a Solidity and Hardhat-based portfolio project that simulates the operational and compliance control layer of a small and medium-sized enterprise (SME) invoice financing workflow. It is designed for banking trade finance, operations, and technology-risk roles.

The project does not attempt to implement a complete letter of credit system or a production banking platform. Instead, it focuses on a narrower and testable workflow: creating an invoice financing application, submitting document hashes, performing compliance checks, obtaining credit approval, reserving MockUSD funding from a finite treasury pool, and releasing simulated funds.

The main design objective is to show how smart contracts can enforce controls that banks already care about:

- segregation of duties
- state-machine-controlled approval sequencing
- tamper-evident audit trail
- on-chain data minimisation
- explicit exception handling
- finite liquidity pool control

## 2. Business Scope

TradeFlow models an SME supplier/exporter applying for invoice financing against an importer/buyer invoice.

The simplified business story is:

1. An exporter creates a financing application for an invoice owed by an importer.
2. The exporter submits document hashes, such as an invoice hash and trade document hash.
3. A compliance officer reviews KYC/AML risk and either passes, rejects, requests revision, or freezes the deal.
4. A credit officer can approve or reject only after compliance has passed.
5. A treasury role funds the approved deal from a pre-funded MockUSD pool.
6. The exporter receives MockUSD after funding and payment release.

This MVP models the operational and compliance workflow before and during disbursement. It does not model buyer repayment, default handling, credit scoring, or recovery.

## 3. Roles And Responsibilities

### 3.1 On-Chain Access-Control Roles

The contract should use OpenZeppelin `AccessControl`.

| Role | Business meaning | Main permissions |
| --- | --- | --- |
| `DEFAULT_ADMIN_ROLE` | Bank system administrator / operations administrator | Grants and revokes bank roles |
| `COMPLIANCE_ROLE` | Compliance officer | Performs KYC/AML decision, requests revision, freezes or rejects on compliance grounds |
| `CREDIT_ROLE` | Senior or credit officer | Approves or rejects financing after compliance has passed |
| `TREASURY_ROLE` | Bank treasury or funding operations | Funds approved deals from the MockUSD liquidity pool and releases payment |

### 3.2 Business Participants

| Participant | Business meaning | Contract role |
| --- | --- | --- |
| Exporter | SME supplier applying for invoice financing | Creates deal and receives financing |
| Importer | Buyer owing the invoice | Recorded as counterparty; repayment is future work |

Exporter and importer are deal-level participants, not global `AccessControl` roles.

### 3.3 Segregation Of Duties

The same address must not hold both `COMPLIANCE_ROLE` and `CREDIT_ROLE`.

This is a preventive control, not merely a detective control. The contract should reject role grants that would create a conflict at the time of `grantRole`, rather than waiting for a later business function to fail.

Rationale:

In a bank control environment, the officer who clears compliance risk should not be the same officer who gives final credit approval. This prevents one account from completing the full approval chain alone.

## 4. Deal Data Model

The contract manages many deals in one contract instance.

This is intentional: a banking workflow system should handle multiple financing applications rather than deploying a new contract for every deal.

Proposed Solidity shape:

```solidity
struct Deal {
    address exporter;
    address importer;
    DealStatus status;
    bytes32 invoiceHash;
    bytes32 tradeDocumentHash;
    bytes32 complianceMemoHash;
    bytes32 approvalNoteHash;
    uint256 invoiceAmount;
    uint256 advanceRateBps;
    uint256 financedAmount;
    uint256 financingFee;
    uint256 dueDate;
    uint256 expiryDeadline;
    uint64 createdAt;
    uint64 updatedAt;
}

mapping(uint256 => Deal) public deals;
uint256 public nextDealId;
mapping(bytes32 => bool) public usedActiveInvoiceHashes;
```

### 4.1 Economic Fields

| Field | Meaning |
| --- | --- |
| `invoiceAmount` | Face value of the invoice in MockUSD smallest units |
| `advanceRateBps` | Financing percentage in basis points, e.g. 8000 = 80% |
| `financedAmount` | Amount actually financed, calculated from invoice amount and advance rate |
| `financingFee` | Simplified flat fee field; real pricing would depend on tenor, risk rating, and bank pricing policy |
| `dueDate` | Invoice maturity date; buyer repayment is out of MVP scope |
| `expiryDeadline` | Funding-window deadline for reaching the funded stage; this is not the underlying invoice maturity or buyer payment due date |

### 4.2 Duplicate Invoice Risk

The contract should prevent the same invoice hash from being financed more than once.

This models a real trade finance fraud pattern: duplicate financing of the same invoice.

Invoice hashes are permanently locked on first use regardless of trade outcome.

For the MVP, this strict no-reuse rule is deliberate:

- reject duplicate `invoiceHash` once any deal has used it
- avoid adding a separate release/reuse governance process
- document that cross-bank duplicate invoice detection is future work

This stricter choice avoids accidental reuse in a student prototype.

## 5. On-Chain Data Minimisation

TradeFlow must not store real documents or sensitive personal/customer data on-chain.

Only hashes are stored:

- invoice hash
- trade document hash
- compliance memo hash
- approval note hash

Rationale:

Trade finance documents may contain customer names, addresses, transaction values, goods descriptions, account details, and KYC/AML information. Public blockchains are transparent and hard to erase, so storing raw documents on-chain would conflict with banking data governance, confidentiality, and privacy principles.

The hash-only design provides tamper evidence: a bank or auditor can later compare an off-chain document with the on-chain hash to verify that the document has not changed.

## 6. MockUSD Settlement Model

TradeFlow should use a simple ERC20 `MockUSD` token rather than native ETH.

Rationale:

Using a dollar-denominated mock token better represents a tokenised deposit or stablecoin-style settlement prototype than paying in ETH. The token has no real-world value and is only used on Sepolia for demonstration.

Preferred funding model:

1. `MockUSD` is minted to a treasury account.
2. The treasury account transfers or approves MockUSD into the TradeFlow contract.
3. `fundDeal` reserves the required `financedAmount` from the contract's available liquidity pool.
4. `releasePayment` transfers MockUSD to the exporter.

The finite pool is intentional. If the TradeFlow contract does not hold enough MockUSD, `fundDeal` must revert cleanly.

This models bank liquidity limits better than minting unlimited tokens during each deal.

## 7. Deal State Machine

### 7.1 States

```text
Created
DocumentsSubmitted
RevisionRequested
CompliancePassed
Frozen
CreditApproved
Funded
PaymentReleased
Rejected
Expired
```

### 7.2 Legal Transitions

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

### 7.3 Terminal States

```text
PaymentReleased
Rejected
Frozen
Expired
```

`Frozen` is terminal in the MVP.

Rationale:

In a real bank, unfreezing a sanctions or AML-risk case requires manual investigation, governance, and documented approval. Allowing a frozen deal to silently return to the normal workflow would weaken the control model. Frozen-state unfreezing is therefore future work.

### 7.4 Expiry Model

Solidity has no native scheduler. Expiry must be triggered by a transaction.

The preferred MVP model is lazy expiry:

- state-changing business functions first check whether `block.timestamp > expiryDeadline`
- if expired, the deal is moved to `Expired` and the attempted operation is blocked
- an additional public `markExpired(dealId)` helper may be exposed for testing and frontend clarity

The expiry deadline defines the deadline by which the trade must reach the funded stage. It does not represent the underlying invoice's payment due date.

`CreditApproved` can also expire if treasury funding does not happen before the deadline. This models an approved facility that was not drawn down in time.

## 8. Frozen Versus Pausable

`Frozen` and `Pausable` represent different risk controls.

| Control | Scope | Meaning |
| --- | --- | --- |
| `Frozen` | Single deal | This specific deal has a compliance risk, such as sanctions or AML concern |
| `Pausable` | Whole contract | The bank pauses the entire system due to operational risk, contract issue, incident response, or regulatory instruction |

All state-changing business functions should be blocked when the contract is paused.

This separation is useful for banking technology-risk discussion because it distinguishes transaction-level risk from system-level operational risk.

## 9. Core Functions

Proposed function set:

```solidity
createDeal(
    address importer,
    uint256 invoiceAmount,
    uint256 advanceRateBps,
    uint256 financingFee,
    uint256 dueDate,
    uint256 expiryDeadline
)

submitDocuments(
    uint256 dealId,
    bytes32 invoiceHash,
    bytes32 tradeDocumentHash
)

requestRevision(uint256 dealId, bytes32 complianceMemoHash)

passCompliance(uint256 dealId, bytes32 complianceMemoHash)

freezeDeal(uint256 dealId, bytes32 complianceMemoHash)

rejectAtCompliance(uint256 dealId, bytes32 complianceMemoHash)

approveCredit(uint256 dealId, bytes32 approvalNoteHash)

rejectAtCredit(uint256 dealId, bytes32 approvalNoteHash)

fundDeal(uint256 dealId)

releasePayment(uint256 dealId)

markExpired(uint256 dealId)

pause()

unpause()
```

Exact names can change during implementation, but the permissions and transitions should remain stable.

## 10. Audit Events

Every material state change should emit an event with:

- deal id
- actor address
- timestamp
- previous status where useful
- new status
- relevant hash where applicable
- amount where applicable

Proposed events:

```solidity
event DealCreated(uint256 indexed dealId, address indexed exporter, address indexed importer, uint256 invoiceAmount, uint256 financedAmount, uint256 dueDate, uint256 timestamp);
event DocumentsSubmitted(uint256 indexed dealId, address indexed exporter, bytes32 invoiceHash, bytes32 tradeDocumentHash, uint256 timestamp);
event RevisionRequested(uint256 indexed dealId, address indexed complianceOfficer, bytes32 complianceMemoHash, uint256 timestamp);
event ComplianceChecked(uint256 indexed dealId, address indexed complianceOfficer, bool passed, bytes32 complianceMemoHash, uint256 timestamp);
event DealFrozen(uint256 indexed dealId, address indexed complianceOfficer, bytes32 complianceMemoHash, uint256 timestamp);
event DealRejected(uint256 indexed dealId, address indexed actor, DealStatus previousStatus, bytes32 reasonHash, uint256 timestamp);
event CreditApproved(uint256 indexed dealId, address indexed creditOfficer, bytes32 approvalNoteHash, uint256 timestamp);
event DealFunded(uint256 indexed dealId, address indexed treasury, uint256 amount, uint256 timestamp);
event PaymentReleased(uint256 indexed dealId, address indexed exporter, uint256 amount, uint256 timestamp);
event DealExpired(uint256 indexed dealId, address indexed actor, DealStatus previousStatus, uint256 timestamp);
```

Rationale:

Events provide a lightweight on-chain audit trail. They are cheaper than storing full histories in contract storage and can be indexed by off-chain analytics, monitoring, or audit tools.

## 11. Security Controls

Implementation should use:

- OpenZeppelin `AccessControl`
- OpenZeppelin `Pausable`
- OpenZeppelin `ReentrancyGuard`
- OpenZeppelin `SafeERC20`
- Solidity `^0.8.x` overflow checks
- custom errors for clear and gas-efficient reverts where appropriate

Important controls:

- role exclusivity between compliance and credit roles
- strict state preconditions on every business function
- duplicate invoice hash prevention
- zero-address validation for participants and token addresses
- amount and basis-point validation
- expiry validation
- treasury liquidity checks
- `nonReentrant` around payment release
- paused contract blocks all state-changing workflow operations

## 12. Test Matrix

### 12.1 Positive Flow Tests

- create a deal
- submit documents
- pass compliance
- approve credit
- fund from MockUSD pool
- release payment to exporter
- verify final status and balances
- verify expected events

### 12.2 Permission Tests

- non-compliance account cannot pass compliance
- non-compliance account cannot request revision, freeze, or reject at compliance
- non-credit account cannot approve or reject after compliance
- non-treasury account cannot fund or release payment
- exporter-only actions cannot be called by unrelated accounts
- admin role can grant/revoke roles
- role exclusivity reverts when granting `COMPLIANCE_ROLE` to an existing `CREDIT_ROLE` holder
- role exclusivity reverts when granting `CREDIT_ROLE` to an existing `COMPLIANCE_ROLE` holder

### 12.3 State Transition Tests

- cannot approve credit before compliance passes
- cannot fund before credit approval
- cannot release before funding
- cannot resubmit documents except from `RevisionRequested`
- cannot operate on terminal states
- cannot perform duplicate release
- cannot skip any required state
- parameterised invalid transition matrix where practical

### 12.4 Exception Path Tests

- compliance can request revision
- exporter can resubmit after revision
- compliance can reject directly from `DocumentsSubmitted`
- compliance can freeze from `DocumentsSubmitted`
- credit can reject from `CompliancePassed`
- frozen deal cannot continue
- rejected deal cannot continue
- expired deal cannot continue

### 12.5 Economic And Funding Tests

- `financedAmount` is calculated from invoice amount and advance rate
- invalid advance rate reverts
- zero invoice amount reverts
- funding fails when MockUSD pool is insufficient
- funding succeeds when pool is sufficient
- duplicate invoice hash reverts

### 12.6 Expiry Tests

- operations before expiry are allowed when otherwise valid
- operation exactly at expiry boundary follows documented rule
- operation after expiry marks deal expired and blocks the attempted transition
- `markExpired` cannot expire terminal states
- `CreditApproved` can expire if not funded in time

### 12.7 Pausable Tests

- paused contract blocks create/submit/check/approve/fund/release
- unpaused contract resumes valid operations
- pause does not change deal-level status
- paused behavior is independent of Frozen deal status

### 12.8 Reentrancy Tests

- `releasePayment` uses `nonReentrant`
- malicious receiver contract cannot re-enter payment release
- repeated payment release reverts even if token callback behavior is simulated

### 12.9 Static Analysis

If feasible, run Slither and document:

- command used
- findings
- whether each finding was fixed, accepted, or false positive
- reason for each decision

## 13. Frontend Demonstration Scope

A minimal React frontend is recommended after the contract and tests are stable.

Frontend goal:

Show the control model, not a polished banking product.

Minimum demo features:

- connect wallet
- display current account and detected role
- create a deal as exporter
- submit document hashes
- pass/reject/freeze/request revision as compliance officer
- approve/reject as credit officer
- fund and release as treasury
- display current deal status
- show expected errors when wrong role attempts an action
- link transactions to Sepolia Etherscan

Demo evidence to capture:

- successful end-to-end flow ending in `PaymentReleased`
- negative flow showing `DuplicateInvoiceHash` when the same invoice hash is reused
- negative flow showing a role-based revert when the wrong officer attempts an action

The most valuable demo moment is showing that invalid actions are blocked, such as a compliance officer trying to approve credit.

## 14. Known Limitations And Scope Boundary

TradeFlow is not production-grade banking software.

It deliberately focuses on the operational/compliance control layer of SME invoice financing. The largest simplification is that buyer repayment and default risk are not modelled in the MVP.

Out of scope for MVP:

- buyer repayment tracking
- default handling and recovery
- credit scoring
- real KYC/AML provider integration
- sanctions oracle
- real customer identity verification
- real document storage
- IPFS document workflow
- partial drawdowns
- partial repayments
- interest accrual
- multi-currency settlement
- multi-bank syndication
- full letter of credit workflow
- Frozen-state unfreezing
- formal dispute resolution
- production privacy architecture

Future work states could include:

```text
PaymentReleased -> RepaymentPending
RepaymentPending -> RepaymentReceived
RepaymentPending -> Defaulted
```

Interview framing:

TradeFlow should be described as a controlled prototype that demonstrates how smart contracts can enforce approval sequencing, segregation of duties, audit logging, duplicate invoice checks, and tokenised settlement simulation. It should not be described as a complete trade finance platform or a complete credit-risk system.

## 15. Suggested CV Description

Built TradeFlow, a Solidity and Hardhat-based SME invoice financing workflow DApp deployed to Ethereum Sepolia. Designed role-separated compliance, credit, and treasury controls using OpenZeppelin AccessControl; implemented a state-machine-driven approval process, hash-only document verification, duplicate invoice prevention, audit events, expiry handling, and MockUSD-based disbursement from a finite liquidity pool. Wrote unit tests for normal flows, permission failures, invalid state transitions, expiry boundaries, funding failures, and payment safety.
