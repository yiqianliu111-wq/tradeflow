const fs = require("fs");
const path = require("path");
const { ethers } = require("hardhat");

function optionalAddress(name) {
  const value = process.env[name];
  if (!value) return undefined;
  if (!ethers.isAddress(value)) {
    throw new Error(`${name} is not a valid address: ${value}`);
  }
  return ethers.getAddress(value);
}

async function grantIfNeeded(contract, roleName, role, account) {
  if (!account) {
    console.log(`${roleName.padEnd(16)} skipped (not configured)`);
    return false;
  }

  const alreadyHasRole = await contract.hasRole(role, account);
  if (alreadyHasRole) {
    console.log(`${roleName.padEnd(16)} already granted to ${account}`);
    return false;
  }

  const tx = await contract.grantRole(role, account);
  await tx.wait();
  console.log(`${roleName.padEnd(16)} granted to ${account}`);
  return true;
}

async function main() {
  const deploymentPath = path.join(__dirname, "..", "deployments", "sepolia.json");
  if (!fs.existsSync(deploymentPath)) {
    throw new Error("Missing deployments/sepolia.json. Deploy to Sepolia first.");
  }

  const deployment = JSON.parse(fs.readFileSync(deploymentPath, "utf8"));
  const tradeFlowAddress = deployment.contracts.tradeFlow.address;
  const tradeFlow = await ethers.getContractAt("TradeFlow", tradeFlowAddress);
  const [sender] = await ethers.getSigners();

  const roleAddresses = {
    exporter: optionalAddress("SEPOLIA_EXPORTER_ADDRESS"),
    importer: optionalAddress("SEPOLIA_IMPORTER_ADDRESS"),
    compliance: optionalAddress("SEPOLIA_COMPLIANCE_ADDRESS"),
    credit: optionalAddress("SEPOLIA_CREDIT_ADDRESS"),
    treasury: optionalAddress("SEPOLIA_TREASURY_ADDRESS"),
  };

  console.log(`Granting roles from admin: ${sender.address}`);
  console.log(`TradeFlow: ${tradeFlowAddress}`);

  await grantIfNeeded(tradeFlow, "COMPLIANCE_ROLE", await tradeFlow.COMPLIANCE_ROLE(), roleAddresses.compliance);
  await grantIfNeeded(tradeFlow, "CREDIT_ROLE", await tradeFlow.CREDIT_ROLE(), roleAddresses.credit);
  await grantIfNeeded(tradeFlow, "TREASURY_ROLE", await tradeFlow.TREASURY_ROLE(), roleAddresses.treasury);

  deployment.demoAccounts = {
    ...deployment.demoAccounts,
    exporter: roleAddresses.exporter || deployment.demoAccounts?.exporter,
    importer: roleAddresses.importer || deployment.demoAccounts?.importer,
    compliance: roleAddresses.compliance || deployment.demoAccounts?.compliance,
    credit: roleAddresses.credit || deployment.demoAccounts?.credit,
    treasury: roleAddresses.treasury || deployment.demoAccounts?.treasury,
  };

  fs.writeFileSync(deploymentPath, JSON.stringify(deployment, null, 2));

  const frontendDeploymentPath = path.join(__dirname, "..", "frontend", "src", "contracts", "deployment.json");
  fs.writeFileSync(frontendDeploymentPath, JSON.stringify(deployment, null, 2));

  console.log("Updated deployments/sepolia.json");
  console.log("Updated frontend/src/contracts/deployment.json");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
