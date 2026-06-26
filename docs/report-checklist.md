# TradeFlow Report And Demo Checklist

Use this checklist when preparing the coursework report, appendix, and presentation screenshots.

## Public Evidence Links

| Evidence | Link |
| --- | --- |
| Public DApp frontend | [https://tradeflow-navy-one.vercel.app/](https://tradeflow-navy-one.vercel.app/) |
| GitHub repository | [https://github.com/yiqianliu111-wq/tradeflow](https://github.com/yiqianliu111-wq/tradeflow) |
| TradeFlow Sepolia contract | [0x27D887fD80167d6e2B989058c3743Bb6bbC03f57](https://sepolia.etherscan.io/address/0x27D887fD80167d6e2B989058c3743Bb6bbC03f57) |
| MockUSD Sepolia contract | [0x117A20022D26c21948625837D05646bc9a7Ed52e](https://sepolia.etherscan.io/address/0x117A20022D26c21948625837D05646bc9a7Ed52e) |

## Screenshot Set

Recommended final screenshots:

1. Frontend overview showing the TradeFlow logo, role cards, available MockUSD, and deployed contract link.
2. Deal dashboard showing a completed `PaymentReleased` deal with financed amount and net disbursement.
3. Role actions plus current role hint, showing that workflow actions are role/status gated.
4. Audit Trail showing confirmed transactions and clickable Sepolia Etherscan links.
5. Etherscan transaction page showing the MockUSD transfer for payment release.
6. Negative-flow screenshot showing duplicate invoice or invalid role/state revert.

## Report Sections

Suggested report structure:

1. Project overview and business motivation.
2. Blockchain relevance: why audit trail, document hashes, and tokenised settlement fit this workflow.
3. Architecture: Solidity contracts, React frontend, Sepolia deployment, MockUSD settlement.
4. Smart contract design: multi-deal state machine, roles, events, and hash-only storage.
5. Banking controls: segregation of duties, duplicate invoice prevention, expiry, pause/freeze, finite liquidity.
6. Testing and security: Hardhat tests, invalid-transition matrix, reentrancy-oriented test, Slither summary.
7. Demo evidence: screenshots and Sepolia/Etherscan links.
8. Limitations and future work: buyer repayment, default handling, real KYC/AML provider, production privacy.

## Presentation Demo Path

The cleanest live demo path is:

1. Open the public frontend and connect MetaMask on Sepolia.
2. Show deployed contract and MockUSD links.
3. Load completed deal `1` and explain the state machine reached `PaymentReleased`.
4. Open Audit Trail or Etherscan evidence for a confirmed transaction.
5. Run a negative-flow demo to show that the smart contract blocks invalid behavior.
6. End by explaining that Exporter and Importer are deal-level participants, while Compliance, Credit, and Treasury are bank-control roles.

## One-Sentence Summary

TradeFlow is a Sepolia-deployed invoice financing workflow DApp that demonstrates banking-style controls: role-separated approvals, state-machine enforcement, hash-only document evidence, duplicate invoice prevention, finite MockUSD liquidity, and on-chain audit logs.
