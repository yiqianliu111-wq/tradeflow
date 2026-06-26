const fs = require("fs");
const path = require("path");
const { ethers, artifacts, network } = require("hardhat");

async function main() {
  const [admin, exporter, importer, compliance, credit, treasury] = await ethers.getSigners();

  const MockUSD = await ethers.getContractFactory("MockUSD");
  const mockUSD = await MockUSD.deploy(admin.address);
  await mockUSD.waitForDeployment();

  const TradeFlow = await ethers.getContractFactory("TradeFlow");
  const tradeFlow = await TradeFlow.deploy(await mockUSD.getAddress(), admin.address);
  await tradeFlow.waitForDeployment();

  await (await tradeFlow.grantRole(await tradeFlow.COMPLIANCE_ROLE(), compliance.address)).wait();
  await (await tradeFlow.grantRole(await tradeFlow.CREDIT_ROLE(), credit.address)).wait();
  await (await tradeFlow.grantRole(await tradeFlow.TREASURY_ROLE(), treasury.address)).wait();

  const treasurySeed = ethers.parseUnits("1000000", 18);
  await (await mockUSD.mint(treasury.address, treasurySeed)).wait();
  await (await mockUSD.connect(treasury).transfer(await tradeFlow.getAddress(), treasurySeed)).wait();

  const tradeFlowArtifact = await artifacts.readArtifact("TradeFlow");
  const mockUSDArtifact = await artifacts.readArtifact("MockUSD");

  const deployment = {
    network: network.name,
    chainId: network.config.chainId ?? 31337,
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
      admin: admin.address,
      exporter: exporter.address,
      importer: importer.address,
      compliance: compliance.address,
      credit: credit.address,
      treasury: treasury.address,
    },
  };

  const outDir = path.join(__dirname, "..", "frontend", "src", "contracts");
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, "deployment.json"), JSON.stringify(deployment, null, 2));

  console.log("Local deployment complete");
  console.log(`MockUSD:   ${deployment.contracts.mockUSD.address}`);
  console.log(`TradeFlow: ${deployment.contracts.tradeFlow.address}`);
  console.log(`Deployment config written to: ${path.join(outDir, "deployment.json")}`);
  console.log("");
  console.log("Demo accounts:");
  for (const [role, address] of Object.entries(deployment.demoAccounts)) {
    console.log(`${role.padEnd(11)} ${address}`);
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
