# Sepolia Deployment Guide

This guide prepares TradeFlow for a public testnet demo.

## Public Deployment

| Resource | Link |
| --- | --- |
| Public frontend | [https://tradeflow-navy-one.vercel.app/](https://tradeflow-navy-one.vercel.app/) |
| GitHub repository | [https://github.com/yiqianliu111-wq/tradeflow](https://github.com/yiqianliu111-wq/tradeflow) |
| TradeFlow contract | [0x27D887fD80167d6e2B989058c3743Bb6bbC03f57](https://sepolia.etherscan.io/address/0x27D887fD80167d6e2B989058c3743Bb6bbC03f57) |
| MockUSD contract | [0x117A20022D26c21948625837D05646bc9a7Ed52e](https://sepolia.etherscan.io/address/0x117A20022D26c21948625837D05646bc9a7Ed52e) |

## 1. Prerequisites

- MetaMask or another wallet
- Sepolia test ETH for gas
- An RPC URL from Infura, Alchemy, or another provider
- A fresh demo private key for deployment

Do not use a wallet that holds real funds. Do not paste a private key into chat, README files, screenshots, or GitHub.

## 2. Configure `.env`

Copy `.env.example` to `.env`:

```powershell
Copy-Item .env.example .env
```

Fill in:

```text
SEPOLIA_RPC_URL=...
PRIVATE_KEY=...
```

Optional role addresses:

```text
SEPOLIA_EXPORTER_ADDRESS=
SEPOLIA_IMPORTER_ADDRESS=
SEPOLIA_COMPLIANCE_ADDRESS=
SEPOLIA_CREDIT_ADDRESS=
SEPOLIA_TREASURY_ADDRESS=
```

If role addresses are provided, the deployment script grants:

- `COMPLIANCE_ROLE` to `SEPOLIA_COMPLIANCE_ADDRESS`
- `CREDIT_ROLE` to `SEPOLIA_CREDIT_ADDRESS`
- `TREASURY_ROLE` to `SEPOLIA_TREASURY_ADDRESS`

If `SEPOLIA_TREASURY_ADDRESS` is blank, the deployer receives `TREASURY_ROLE`.

The exporter and importer addresses are not global contract roles. They are written to the frontend config as demo convenience addresses.

## 3. Deploy

```powershell
npm run compile
npm run deploy:sepolia
```

The script will:

1. deploy `MockUSD`
2. deploy `TradeFlow`
3. seed the TradeFlow contract with 1,000,000 mUSD
4. grant configured roles
5. write frontend config to `frontend/src/contracts/deployment.json`
6. write a deployment record to `deployments/sepolia.json`

## 4. Frontend

After deployment:

```powershell
npm run frontend:build
npm run frontend:dev
```

Switch MetaMask to Sepolia and connect the role wallets.

## 5. Grant Or Update Demo Roles After Deployment

If you deployed before deciding the compliance and credit addresses, add them to `.env`:

```text
SEPOLIA_COMPLIANCE_ADDRESS=0x...
SEPOLIA_CREDIT_ADDRESS=0x...
SEPOLIA_TREASURY_ADDRESS=
```

Then run:

```powershell
npm run grant:sepolia
```

The script reads `deployments/sepolia.json`, grants configured roles, and updates:

```text
deployments/sepolia.json
frontend/src/contracts/deployment.json
```

## 6. Verification Checklist

- `frontend/src/contracts/deployment.json` contains Sepolia addresses
- `deployments/sepolia.json` is saved
- MockUSD and TradeFlow addresses open on Sepolia Etherscan
- `availableLiquidity()` returns the seeded mUSD pool
- compliance and credit roles are held by different addresses
- wrong-role actions revert in the frontend execution log

## 7. Safety Notes

- `.env` is gitignored.
- Use a dedicated demo wallet.
- Never commit private keys.
- The MockUSD token is a test token with no monetary value.
- This is not a production banking system.
