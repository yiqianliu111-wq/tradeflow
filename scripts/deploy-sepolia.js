const fs = require("fs");
const path = require("path");
const { ethers, artifacts, network } = require("hardhat");

function optionalAddress(name) {
  const value = process.env[name];
  if (!value) return undefined;
  if (!ethers.isAddress(value)) {
    throw new Error(`${name} is not a valid address: ${value}`);
  }
  return ethers.getAddress(value);
}

async function main() {
  const [deployer] = await ethers.getSigners();
  console.log(`Deploying with: ${deployer.address}`);

  const roleAddresses = {
    exporter: optionalAddress("SEPOLIA_EXPORTER_ADDRESS"),
    importer: optionalAddress("SEPOLIA_IMPORTER_ADDRESS"),
    compliance: optionalAddress("SEPOLIA_COMPLIANCE_ADDRESS"),
    credit: optionalAddress("SEPOLIA_CREDIT_ADDRESS"),
    treasury: optionalAddress("SEPOLIA_TREASURY_ADDRESS") || deployer.address,
  };

  const MockUSD = await ethers.getContractFactory("MockUSD");
  const mockUSD = await MockUSD.deploy(deployer.address);
  await mockUSD.waitForDeployment();

  const TradeFlow = await ethers.getContractFactory("TradeFlow");
  const tradeFlow = await TradeFlow.deploy(await mockUSD.getAddress(), deployer.address);
  await tradeFlow.waitForDeployment();

  const treasurySeed = ethers.parseUnits("1000000", 18);
  await (await mockUSD.mint(deployer.address, treasurySeed)).wait();
  await (await mockUSD.transfer(await tradeFlow.getAddress(), treasurySeed)).wait();

  if (roleAddresses.compliance) {
    await (await tradeFlow.grantRole(await tradeFlow.COMPLIANCE_ROLE(), roleAddresses.compliance)).wait();
  }
  if (roleAddresses.credit) {
    await (await tradeFlow.grantRole(await tradeFlow.CREDIT_ROLE(), roleAddresses.credit)).wait();
  }
  await (await tradeFlow.grantRole(await tradeFlow.TREASURY_ROLE(), roleAddresses.treasury)).wait();

  const tradeFlowArtifact = await artifacts.readArtifact("TradeFlow");
  const mockUSDArtifact = await artifacts.readArtifact("MockUSD");

  const deployment = {
    network: network.name,
    chainId: network.config.chainId ?? 11155111,
    contracts: {
      tradeFlow: {
        address: await tradeFlow.getAddress(),
        abi: tradeFlowArtifact.abi,
      },
      mockUSD: {
        address: await mockUSD.getAddress(),
        abi: mockUSDArtifact.abi,
      },
    },
    demoAccounts: {
      admin: deployer.address,
      exporter: roleAddresses.exporter,
      importer: roleAddresses.importer,
      compliance: roleAddresses.compliance,
      credit: roleAddresses.credit,
      treasury: roleAddresses.treasury,
    },
  };

  const outDir = path.join(__dirname, "..", "frontend", "src", "contracts");
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, "deployment.json"), JSON.stringify(deployment, null, 2));

  const deployedDir = path.join(__dirname, "..", "deployments");
  fs.mkdirSync(deployedDir, { recursive: true });
  fs.writeFileSync(path.join(deployedDir, "sepolia.json"), JSON.stringify(deployment, null, 2));

  console.log(`MockUSD:   ${deployment.contracts.mockUSD.address}`);
  console.log(`TradeFlow: ${deployment.contracts.tradeFlow.address}`);
  console.log(`Seeded TradeFlow liquidity: ${ethers.formatUnits(treasurySeed, 18)} mUSD`);
  console.log(`Frontend config written to: ${path.join(outDir, "deployment.json")}`);
  console.log(`Deployment record written to: ${path.join(deployedDir, "sepolia.json")}`);
  console.log("");
  console.log("Configured role/demo addresses:");
  for (const [role, address] of Object.entries(deployment.demoAccounts)) {
    console.log(`${role.padEnd(11)} ${address || "(not configured)"}`);
  }
  console.log("");
  console.log("Etherscan:");
  console.log(`MockUSD:   https://sepolia.etherscan.io/address/${deployment.contracts.mockUSD.address}`);
  console.log(`TradeFlow: https://sepolia.etherscan.io/address/${deployment.contracts.tradeFlow.address}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
