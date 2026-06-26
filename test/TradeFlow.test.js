const { expect } = require("chai");
const { ethers } = require("hardhat");
const { anyValue } = require("@nomicfoundation/hardhat-chai-matchers/withArgs");

const Status = {
  Created: 0,
  DocumentsSubmitted: 1,
  RevisionRequested: 2,
  CompliancePassed: 3,
  Frozen: 4,
  CreditApproved: 5,
  Funded: 6,
  PaymentReleased: 7,
  Rejected: 8,
  Expired: 9,
};

describe("TradeFlow", function () {
  let admin;
  let exporter;
  let importer;
  let compliance;
  let credit;
  let treasury;
  let outsider;
  let mockUSD;
  let tradeFlow;
  let roles;

  const invoiceAmount = ethers.parseUnits("10000", 18);
  const advanceRateBps = 8000n;
  const financedAmount = ethers.parseUnits("8000", 18);
  const financingFee = ethers.parseUnits("100", 18);
  const treasurySeed = ethers.parseUnits("1000000", 18);

  const invoiceHash = ethers.keccak256(ethers.toUtf8Bytes("invoice-001"));
  const invoiceHash2 = ethers.keccak256(ethers.toUtf8Bytes("invoice-002"));
  const documentHash = ethers.keccak256(ethers.toUtf8Bytes("bill-of-lading-001"));
  const revisedDocumentHash = ethers.keccak256(ethers.toUtf8Bytes("bill-of-lading-001-revised"));
  const complianceMemoHash = ethers.keccak256(ethers.toUtf8Bytes("kyc-aml-pass"));
  const complianceRejectHash = ethers.keccak256(ethers.toUtf8Bytes("kyc-aml-reject"));
  const sanctionsMemoHash = ethers.keccak256(ethers.toUtf8Bytes("sanctions-hit"));
  const revisionMemoHash = ethers.keccak256(ethers.toUtf8Bytes("missing-document"));
  const approvalNoteHash = ethers.keccak256(ethers.toUtf8Bytes("credit-approved"));
  const creditRejectHash = ethers.keccak256(ethers.toUtf8Bytes("credit-rejected"));
  const matrixHashSalt = ethers.keccak256(ethers.toUtf8Bytes("matrix-hash"));

  async function now() {
    return BigInt((await ethers.provider.getBlock("latest")).timestamp);
  }

  async function future(seconds) {
    return (await now()) + BigInt(seconds);
  }

  async function deployFixture() {
    [admin, exporter, importer, compliance, credit, treasury, outsider] = await ethers.getSigners();

    const MockUSD = await ethers.getContractFactory("MockUSD");
    mockUSD = await MockUSD.deploy(admin.address);

    const TradeFlow = await ethers.getContractFactory("TradeFlow");
    tradeFlow = await TradeFlow.deploy(await mockUSD.getAddress(), admin.address);

    roles = {
      compliance: await tradeFlow.COMPLIANCE_ROLE(),
      credit: await tradeFlow.CREDIT_ROLE(),
      treasury: await tradeFlow.TREASURY_ROLE(),
    };

    await tradeFlow.connect(admin).grantRole(roles.compliance, compliance.address);
    await tradeFlow.connect(admin).grantRole(roles.credit, credit.address);
    await tradeFlow.connect(admin).grantRole(roles.treasury, treasury.address);

    await mockUSD.connect(admin).mint(treasury.address, treasurySeed);
    await mockUSD.connect(treasury).transfer(await tradeFlow.getAddress(), treasurySeed);
  }

  async function createDeal(overrides = {}) {
    const dueDate = overrides.dueDate ?? (await future(30 * 24 * 60 * 60));
    const expiryDeadline = overrides.expiryDeadline ?? (await future(7 * 24 * 60 * 60));

    const tx = await tradeFlow.connect(overrides.exporter ?? exporter).createDeal(
      overrides.importer ?? importer.address,
      overrides.invoiceAmount ?? invoiceAmount,
      overrides.advanceRateBps ?? advanceRateBps,
      overrides.financingFee ?? financingFee,
      dueDate,
      expiryDeadline,
    );
    const receipt = await tx.wait();
    const event = receipt.logs
      .map((log) => {
        try {
          return tradeFlow.interface.parseLog(log);
        } catch (_) {
          return undefined;
        }
      })
      .find((parsed) => parsed && parsed.name === "DealCreated");
    return event.args.dealId;
  }

  async function submitDealDocuments(dealId, hash = invoiceHash) {
    await tradeFlow.connect(exporter).submitDocuments(dealId, hash, documentHash);
  }

  async function reachCompliancePassed(dealId) {
    await submitDealDocuments(dealId);
    await tradeFlow.connect(compliance).passCompliance(dealId, complianceMemoHash);
  }

  async function reachCreditApproved(dealId) {
    await reachCompliancePassed(dealId);
    await tradeFlow.connect(credit).approveCredit(dealId, approvalNoteHash);
  }

  async function getDeal(dealId) {
    return tradeFlow.deals(dealId);
  }

  function uniqueHash(label) {
    return ethers.keccak256(ethers.solidityPacked(["bytes32", "string"], [matrixHashSalt, label]));
  }

  async function createDealFromState(targetState, label = targetState) {
    const dealId = await createDeal();
    const invHash = uniqueHash(`invoice-${label}`);
    const docHash = uniqueHash(`document-${label}`);

    if (targetState === "Created") return dealId;

    await tradeFlow.connect(exporter).submitDocuments(dealId, invHash, docHash);
    if (targetState === "DocumentsSubmitted") return dealId;

    if (targetState === "RevisionRequested") {
      await tradeFlow.connect(compliance).requestRevision(dealId, revisionMemoHash);
      return dealId;
    }

    if (targetState === "Frozen") {
      await tradeFlow.connect(compliance).freezeDeal(dealId, sanctionsMemoHash);
      return dealId;
    }

    if (targetState === "RejectedCompliance") {
      await tradeFlow.connect(compliance).rejectAtCompliance(dealId, complianceRejectHash);
      return dealId;
    }

    await tradeFlow.connect(compliance).passCompliance(dealId, complianceMemoHash);
    if (targetState === "CompliancePassed") return dealId;

    if (targetState === "RejectedCredit") {
      await tradeFlow.connect(credit).rejectAtCredit(dealId, creditRejectHash);
      return dealId;
    }

    await tradeFlow.connect(credit).approveCredit(dealId, approvalNoteHash);
    if (targetState === "CreditApproved") return dealId;

    await tradeFlow.connect(treasury).fundDeal(dealId);
    if (targetState === "Funded") return dealId;

    await tradeFlow.connect(treasury).releasePayment(dealId);
    if (targetState === "PaymentReleased") return dealId;

    throw new Error(`Unsupported target state: ${targetState}`);
  }

  async function attemptWorkflowAction(action, dealId, label = action) {
    const invHash = uniqueHash(`attempt-invoice-${label}`);
    const docHash = uniqueHash(`attempt-document-${label}`);
    const memoHash = uniqueHash(`attempt-memo-${label}`);

    const actions = {
      submitDocuments: () => tradeFlow.connect(exporter).submitDocuments(dealId, invHash, docHash),
      requestRevision: () => tradeFlow.connect(compliance).requestRevision(dealId, memoHash),
      passCompliance: () => tradeFlow.connect(compliance).passCompliance(dealId, memoHash),
      freezeDeal: () => tradeFlow.connect(compliance).freezeDeal(dealId, memoHash),
      rejectAtCompliance: () => tradeFlow.connect(compliance).rejectAtCompliance(dealId, memoHash),
      approveCredit: () => tradeFlow.connect(credit).approveCredit(dealId, memoHash),
      rejectAtCredit: () => tradeFlow.connect(credit).rejectAtCredit(dealId, memoHash),
      fundDeal: () => tradeFlow.connect(treasury).fundDeal(dealId),
      releasePayment: () => tradeFlow.connect(treasury).releasePayment(dealId),
    };

    return actions[action]();
  }

  beforeEach(async function () {
    await deployFixture();
  });

  describe("happy path", function () {
    it("runs an invoice financing workflow with audit events and MockUSD disbursement", async function () {
      const dealId = await createDeal();

      await expect(tradeFlow.connect(exporter).submitDocuments(dealId, invoiceHash, documentHash))
        .to.emit(tradeFlow, "DocumentsSubmitted")
        .withArgs(dealId, exporter.address, invoiceHash, documentHash, anyValue);

      await expect(tradeFlow.connect(compliance).passCompliance(dealId, complianceMemoHash))
        .to.emit(tradeFlow, "ComplianceChecked")
        .withArgs(dealId, compliance.address, true, complianceMemoHash, anyValue);

      await expect(tradeFlow.connect(credit).approveCredit(dealId, approvalNoteHash))
        .to.emit(tradeFlow, "CreditApproved")
        .withArgs(dealId, credit.address, approvalNoteHash, anyValue);

      await expect(tradeFlow.connect(treasury).fundDeal(dealId))
        .to.emit(tradeFlow, "DealFunded")
        .withArgs(dealId, treasury.address, financedAmount, anyValue);

      const exporterBefore = await mockUSD.balanceOf(exporter.address);
      const expectedNetDisbursement = financedAmount - financingFee;

      await expect(tradeFlow.connect(treasury).releasePayment(dealId))
        .to.emit(tradeFlow, "PaymentReleased")
        .withArgs(dealId, exporter.address, expectedNetDisbursement, anyValue);

      const deal = await getDeal(dealId);
      expect(deal.status).to.equal(Status.PaymentReleased);
      expect(await mockUSD.balanceOf(exporter.address)).to.equal(exporterBefore + expectedNetDisbursement);
      expect(await tradeFlow.totalReserved()).to.equal(0);
    });

    it("calculates financed amount from invoice amount and advance rate", async function () {
      const dealId = await createDeal();
      const deal = await getDeal(dealId);

      expect(deal.invoiceAmount).to.equal(invoiceAmount);
      expect(deal.advanceRateBps).to.equal(advanceRateBps);
      expect(deal.financedAmount).to.equal(financedAmount);
      expect(await tradeFlow.disbursementAmount(dealId)).to.equal(financedAmount - financingFee);
    });
  });

  describe("role controls", function () {
    it("prevents the same address from holding compliance and credit roles", async function () {
      await expect(tradeFlow.connect(admin).grantRole(roles.credit, compliance.address))
        .to.be.revertedWithCustomError(tradeFlow, "RoleConflict")
        .withArgs(roles.credit, compliance.address);

      await expect(tradeFlow.connect(admin).grantRole(roles.compliance, credit.address))
        .to.be.revertedWithCustomError(tradeFlow, "RoleConflict")
        .withArgs(roles.compliance, credit.address);
    });

    it("rejects compliance actions from non-compliance accounts", async function () {
      const dealId = await createDeal();
      await submitDealDocuments(dealId);

      await expect(tradeFlow.connect(outsider).passCompliance(dealId, complianceMemoHash))
        .to.be.revertedWithCustomError(tradeFlow, "AccessControlUnauthorizedAccount")
        .withArgs(outsider.address, roles.compliance);
    });

    it("rejects credit approval from non-credit accounts", async function () {
      const dealId = await createDeal();
      await reachCompliancePassed(dealId);

      await expect(tradeFlow.connect(compliance).approveCredit(dealId, approvalNoteHash))
        .to.be.revertedWithCustomError(tradeFlow, "AccessControlUnauthorizedAccount")
        .withArgs(compliance.address, roles.credit);
    });

    it("rejects treasury actions from non-treasury accounts", async function () {
      const dealId = await createDeal();
      await reachCreditApproved(dealId);

      await expect(tradeFlow.connect(credit).fundDeal(dealId))
        .to.be.revertedWithCustomError(tradeFlow, "AccessControlUnauthorizedAccount")
        .withArgs(credit.address, roles.treasury);
    });

    it("only lets the exporter submit documents for its deal", async function () {
      const dealId = await createDeal();

      await expect(tradeFlow.connect(outsider).submitDocuments(dealId, invoiceHash, documentHash))
        .to.be.revertedWithCustomError(tradeFlow, "UnauthorizedExporter")
        .withArgs(outsider.address, exporter.address);
    });
  });

  describe("state machine", function () {
    it("prevents skipping compliance before credit approval", async function () {
      const dealId = await createDeal();
      await submitDealDocuments(dealId);

      await expect(tradeFlow.connect(credit).approveCredit(dealId, approvalNoteHash))
        .to.be.revertedWithCustomError(tradeFlow, "InvalidStatus")
        .withArgs(Status.DocumentsSubmitted, Status.CompliancePassed);
    });

    it("prevents funding before credit approval", async function () {
      const dealId = await createDeal();
      await reachCompliancePassed(dealId);

      await expect(tradeFlow.connect(treasury).fundDeal(dealId))
        .to.be.revertedWithCustomError(tradeFlow, "InvalidStatus")
        .withArgs(Status.CompliancePassed, Status.CreditApproved);
    });

    it("prevents releasing before funding and prevents duplicate release", async function () {
      const dealId = await createDeal();
      await reachCreditApproved(dealId);

      await expect(tradeFlow.connect(treasury).releasePayment(dealId))
        .to.be.revertedWithCustomError(tradeFlow, "InvalidStatus")
        .withArgs(Status.CreditApproved, Status.Funded);

      await tradeFlow.connect(treasury).fundDeal(dealId);
      await tradeFlow.connect(treasury).releasePayment(dealId);

      await expect(tradeFlow.connect(treasury).releasePayment(dealId))
        .to.be.revertedWithCustomError(tradeFlow, "InvalidStatus")
        .withArgs(Status.PaymentReleased, Status.Funded);
    });

    it("supports revision request and resubmission loop", async function () {
      const dealId = await createDeal();
      await submitDealDocuments(dealId);

      await tradeFlow.connect(compliance).requestRevision(dealId, revisionMemoHash);
      expect((await getDeal(dealId)).status).to.equal(Status.RevisionRequested);

      await tradeFlow.connect(exporter).submitDocuments(dealId, invoiceHash, revisedDocumentHash);
      expect((await getDeal(dealId)).status).to.equal(Status.DocumentsSubmitted);

      await tradeFlow.connect(compliance).passCompliance(dealId, complianceMemoHash);
      expect((await getDeal(dealId)).status).to.equal(Status.CompliancePassed);
    });

    it("supports compliance rejection, freeze, and credit rejection as distinct exception paths", async function () {
      const complianceRejected = await createDeal();
      await submitDealDocuments(complianceRejected, invoiceHash);
      await tradeFlow.connect(compliance).rejectAtCompliance(complianceRejected, complianceRejectHash);
      expect((await getDeal(complianceRejected)).status).to.equal(Status.Rejected);

      const frozen = await createDeal();
      await submitDealDocuments(frozen, invoiceHash2);
      await tradeFlow.connect(compliance).freezeDeal(frozen, sanctionsMemoHash);
      expect((await getDeal(frozen)).status).to.equal(Status.Frozen);

      const creditRejected = await createDeal();
      const thirdInvoice = ethers.keccak256(ethers.toUtf8Bytes("invoice-003"));
      await submitDealDocuments(creditRejected, thirdInvoice);
      await tradeFlow.connect(compliance).passCompliance(creditRejected, complianceMemoHash);
      await tradeFlow.connect(credit).rejectAtCredit(creditRejected, creditRejectHash);
      expect((await getDeal(creditRejected)).status).to.equal(Status.Rejected);
    });

    it("blocks terminal frozen deals from continuing", async function () {
      const dealId = await createDeal();
      await submitDealDocuments(dealId);
      await tradeFlow.connect(compliance).freezeDeal(dealId, sanctionsMemoHash);

      await expect(tradeFlow.connect(credit).approveCredit(dealId, approvalNoteHash))
        .to.be.revertedWithCustomError(tradeFlow, "InvalidStatus")
        .withArgs(Status.Frozen, Status.CompliancePassed);
    });

    it("systematically rejects invalid state-function combinations", async function () {
      const validTransitions = {
        Created: new Set(["submitDocuments"]),
        DocumentsSubmitted: new Set([
          "requestRevision",
          "passCompliance",
          "freezeDeal",
          "rejectAtCompliance",
        ]),
        RevisionRequested: new Set(["submitDocuments"]),
        CompliancePassed: new Set(["approveCredit", "rejectAtCredit"]),
        Frozen: new Set(),
        CreditApproved: new Set(["fundDeal"]),
        Funded: new Set(["releasePayment"]),
        PaymentReleased: new Set(),
        RejectedCompliance: new Set(),
        RejectedCredit: new Set(),
      };

      const actions = [
        "submitDocuments",
        "requestRevision",
        "passCompliance",
        "freezeDeal",
        "rejectAtCompliance",
        "approveCredit",
        "rejectAtCredit",
        "fundDeal",
        "releasePayment",
      ];

      let validCount = 0;
      let invalidCount = 0;

      for (const [stateName, validActions] of Object.entries(validTransitions)) {
        for (const action of actions) {
          const label = `${stateName}-${action}`;
          const dealId = await createDealFromState(stateName, label);

          if (validActions.has(action)) {
            await expect(attemptWorkflowAction(action, dealId, label)).to.not.be.reverted;
            validCount += 1;
          } else {
            await expect(attemptWorkflowAction(action, dealId, label)).to.be.reverted;
            invalidCount += 1;
          }
        }
      }

      expect(validCount).to.equal(10);
      expect(invalidCount).to.equal(80);
    });
  });

  describe("economic controls", function () {
    it("prevents duplicate invoice financing", async function () {
      const firstDeal = await createDeal();
      await submitDealDocuments(firstDeal, invoiceHash);

      const secondDeal = await createDeal();
      await expect(tradeFlow.connect(exporter).submitDocuments(secondDeal, invoiceHash, documentHash))
        .to.be.revertedWithCustomError(tradeFlow, "DuplicateInvoiceHash")
        .withArgs(invoiceHash, firstDeal);
    });

    it("rejects invalid economic inputs", async function () {
      await expect(createDeal({ invoiceAmount: 0n })).to.be.revertedWithCustomError(tradeFlow, "InvalidAmount");
      await expect(createDeal({ advanceRateBps: 0n })).to.be.revertedWithCustomError(tradeFlow, "InvalidAdvanceRate");
      await expect(createDeal({ advanceRateBps: 10001n })).to.be.revertedWithCustomError(
        tradeFlow,
        "InvalidAdvanceRate",
      );
      await expect(createDeal({ financingFee: financedAmount })).to.be.revertedWithCustomError(
        tradeFlow,
        "InvalidFee",
      );
    });

    it("reverts funding when the finite liquidity pool is insufficient", async function () {
      const dealId = await createDeal({ invoiceAmount: ethers.parseUnits("2000000", 18) });
      await reachCreditApproved(dealId);

      await expect(tradeFlow.connect(treasury).fundDeal(dealId))
        .to.be.revertedWithCustomError(tradeFlow, "InsufficientLiquidity");
    });
  });

  describe("expiry", function () {
    it("expires an eligible deal after the deadline", async function () {
      const expiryDeadline = (await future(60));
      const dueDate = expiryDeadline + 1000n;
      const dealId = await createDeal({ expiryDeadline, dueDate });

      await ethers.provider.send("evm_setNextBlockTimestamp", [Number(expiryDeadline + 1n)]);
      await expect(tradeFlow.connect(outsider).markExpired(dealId))
        .to.emit(tradeFlow, "DealExpired")
        .withArgs(dealId, outsider.address, Status.Created, anyValue);

      expect((await getDeal(dealId)).status).to.equal(Status.Expired);
    });

    it("uses a strict boundary: exactly at deadline is not expired, one second after is expired", async function () {
      const expiryDeadline = (await future(60));
      const dueDate = expiryDeadline + 1000n;
      const dealId = await createDeal({ expiryDeadline, dueDate });

      await ethers.provider.send("evm_setNextBlockTimestamp", [Number(expiryDeadline)]);
      await expect(tradeFlow.connect(outsider).markExpired(dealId))
        .to.be.revertedWithCustomError(tradeFlow, "NotExpired");

      await ethers.provider.send("evm_setNextBlockTimestamp", [Number(expiryDeadline + 1n)]);
      await tradeFlow.connect(outsider).markExpired(dealId);
      expect((await getDeal(dealId)).status).to.equal(Status.Expired);
    });

    it("lazily expires a credit-approved deal instead of allowing funding after deadline", async function () {
      const expiryDeadline = await future(3600);
      const dueDate = expiryDeadline + 1000n;
      const dealId = await createDeal({ expiryDeadline, dueDate });
      await reachCreditApproved(dealId);

      await ethers.provider.send("evm_setNextBlockTimestamp", [Number(expiryDeadline + 1n)]);
      await tradeFlow.connect(treasury).fundDeal(dealId);

      expect((await getDeal(dealId)).status).to.equal(Status.Expired);
    });

    it("does not expire terminal states", async function () {
      const dealId = await createDeal();
      await submitDealDocuments(dealId);
      await tradeFlow.connect(compliance).freezeDeal(dealId, sanctionsMemoHash);

      await expect(tradeFlow.connect(outsider).markExpired(dealId))
        .to.be.revertedWithCustomError(tradeFlow, "TerminalStatus")
        .withArgs(Status.Frozen);
    });
  });

  describe("pausable", function () {
    it("blocks all key state-changing workflow calls while paused", async function () {
      await tradeFlow.connect(admin).pause();

      await expect(createDeal()).to.be.revertedWithCustomError(tradeFlow, "EnforcedPause");

      await tradeFlow.connect(admin).unpause();
      const dealId = await createDeal();
      await tradeFlow.connect(exporter).submitDocuments(dealId, invoiceHash, documentHash);

      await tradeFlow.connect(admin).pause();
      await expect(tradeFlow.connect(compliance).passCompliance(dealId, complianceMemoHash))
        .to.be.revertedWithCustomError(tradeFlow, "EnforcedPause");

      await tradeFlow.connect(admin).unpause();
      await tradeFlow.connect(compliance).passCompliance(dealId, complianceMemoHash);
      expect((await getDeal(dealId)).status).to.equal(Status.CompliancePassed);
    });
  });

  describe("payment safety", function () {
    it("blocks a malicious treasury/exporter contract from re-entering releasePayment during token transfer", async function () {
      const ReentrantMockUSD = await ethers.getContractFactory("ReentrantMockUSD");
      const reentrantToken = await ReentrantMockUSD.deploy();

      const TradeFlow = await ethers.getContractFactory("TradeFlow");
      const guardedTradeFlow = await TradeFlow.deploy(await reentrantToken.getAddress(), admin.address);

      const complianceRole = await guardedTradeFlow.COMPLIANCE_ROLE();
      const creditRole = await guardedTradeFlow.CREDIT_ROLE();
      const treasuryRole = await guardedTradeFlow.TREASURY_ROLE();

      await guardedTradeFlow.connect(admin).grantRole(complianceRole, compliance.address);
      await guardedTradeFlow.connect(admin).grantRole(creditRole, credit.address);
      await guardedTradeFlow.connect(admin).grantRole(treasuryRole, treasury.address);

      const ReentrantExporter = await ethers.getContractFactory("ReentrantReleaseExporter");
      const maliciousExporter = await ReentrantExporter.deploy(await guardedTradeFlow.getAddress());

      await guardedTradeFlow.connect(admin).grantRole(treasuryRole, await maliciousExporter.getAddress());
      await reentrantToken.mint(await guardedTradeFlow.getAddress(), treasurySeed);

      const expiryDeadline = await future(7 * 24 * 60 * 60);
      const dueDate = expiryDeadline + 30n * 24n * 60n * 60n;

      await maliciousExporter.createDeal(
        importer.address,
        invoiceAmount,
        advanceRateBps,
        financingFee,
        dueDate,
        expiryDeadline,
      );
      const firstDealId = await maliciousExporter.dealId();

      await maliciousExporter.createDeal(
        importer.address,
        invoiceAmount,
        advanceRateBps,
        financingFee,
        dueDate,
        expiryDeadline,
      );
      const secondDealId = await maliciousExporter.dealId();

      for (const [dealId, label] of [
        [firstDealId, "reentrant-first"],
        [secondDealId, "reentrant-second"],
      ]) {
        await maliciousExporter.submitDocuments(dealId, uniqueHash(`${label}-invoice`), uniqueHash(`${label}-document`));
        await guardedTradeFlow.connect(compliance).passCompliance(dealId, complianceMemoHash);
        await guardedTradeFlow.connect(credit).approveCredit(dealId, approvalNoteHash);
        await guardedTradeFlow.connect(treasury).fundDeal(dealId);
      }

      await maliciousExporter.setReentryTargetDealId(secondDealId);

      await guardedTradeFlow.connect(treasury).releasePayment(firstDealId);

      expect(await maliciousExporter.reentryAttempted()).to.equal(true);
      expect(await maliciousExporter.reentrySucceeded()).to.equal(false);
      expect((await guardedTradeFlow.deals(firstDealId)).status).to.equal(Status.PaymentReleased);
      expect((await guardedTradeFlow.deals(secondDealId)).status).to.equal(Status.Funded);
    });
  });
});
