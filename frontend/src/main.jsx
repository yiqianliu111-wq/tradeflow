import React, { useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  AlertTriangle,
  Banknote,
  CheckCircle2,
  ClipboardCheck,
  ExternalLink,
  FileCheck2,
  FilePlus2,
  Lock,
  PauseCircle,
  RefreshCw,
  ShieldCheck,
  Wallet,
  XCircle,
} from "lucide-react";
import { ethers } from "ethers";
import deployment from "./contracts/deployment.json";
import tradeflowLogo from "./assets/tradeflow-logo.svg";
import "./styles.css";

const STATUS = [
  "Created",
  "DocumentsSubmitted",
  "RevisionRequested",
  "CompliancePassed",
  "Frozen",
  "CreditApproved",
  "Funded",
  "PaymentReleased",
  "Rejected",
  "Expired",
];

const WORKFLOW_STEPS = [
  "Created",
  "DocumentsSubmitted",
  "CompliancePassed",
  "CreditApproved",
  "Funded",
  "PaymentReleased",
];

const ZERO_HASH = "0x0000000000000000000000000000000000000000000000000000000000000000";
const SECONDS_IN_DAY = 24 * 60 * 60;
const TRADE_FLOW_INTERFACE = new ethers.Interface(deployment.contracts.tradeFlow.abi);
const SEPOLIA_CHAIN_ID = 11155111n;
const ROLE_LABELS = {
  [ethers.keccak256(ethers.toUtf8Bytes("DEFAULT_ADMIN_ROLE"))]: "DEFAULT_ADMIN_ROLE",
  [ethers.keccak256(ethers.toUtf8Bytes("COMPLIANCE_ROLE"))]: "COMPLIANCE_ROLE",
  [ethers.keccak256(ethers.toUtf8Bytes("CREDIT_ROLE"))]: "CREDIT_ROLE",
  [ethers.keccak256(ethers.toUtf8Bytes("TREASURY_ROLE"))]: "TREASURY_ROLE",
};

function hashText(value) {
  return ethers.keccak256(ethers.toUtf8Bytes(value || "empty"));
}

function shortAddress(value) {
  if (!value) return "Not connected";
  return `${value.slice(0, 6)}...${value.slice(-4)}`;
}

function formatToken(value) {
  try {
    return Number(ethers.formatUnits(value ?? 0n, 18)).toLocaleString(undefined, {
      maximumFractionDigits: 2,
    });
  } catch {
    return "0";
  }
}

function txExplorerUrl(txHash) {
  if (BigInt(deployment.chainId ?? 0) !== SEPOLIA_CHAIN_ID) return "";
  return `https://sepolia.etherscan.io/tx/${txHash}`;
}

function addressExplorerUrl(address) {
  if (BigInt(deployment.chainId ?? 0) !== SEPOLIA_CHAIN_ID) return "";
  return `https://sepolia.etherscan.io/address/${address}`;
}

function formatDate(timestamp) {
  if (!timestamp) return "Not set";
  return new Date(timestamp * 1000).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

function workflowState(status, step) {
  const currentIndex = WORKFLOW_STEPS.indexOf(status);
  const stepIndex = WORKFLOW_STEPS.indexOf(step);

  if (status === "Frozen" || status === "Rejected" || status === "Expired") return "blocked";
  if (currentIndex === -1) return "pending";
  if (stepIndex < currentIndex) return "complete";
  if (stepIndex === currentIndex) return "current";
  return "pending";
}

function roleCapability(roles, account) {
  if (!account) {
    return {
      title: "No wallet connected",
      detail: "Read-only Sepolia dashboard",
    };
  }

  if (roles.includes("Compliance")) {
    return {
      title: "You are: Compliance Officer",
      detail: "KYC/AML review and exception control",
    };
  }

  if (roles.includes("Credit")) {
    return {
      title: "You are: Credit Officer",
      detail: "Post-compliance credit approval",
    };
  }

  if (roles.includes("Treasury")) {
    return {
      title: "You are: Treasury Operations",
      detail: "Liquidity reservation and MockUSD disbursement",
    };
  }

  if (roles.includes("Admin")) {
    return {
      title: "You are: System Admin",
      detail: "Role administration and emergency control",
    };
  }

  return {
    title: "You are: Exporter / Applicant",
    detail: "Application creation and document hash submission",
  };
}

function statusClass(status) {
  return `status status-${status || "Unknown"}`;
}

function formatRole(role) {
  return ROLE_LABELS[role] || role;
}

function extractErrorData(error) {
  return (
    error?.data ||
    error?.error?.data ||
    error?.info?.error?.data ||
    error?.info?.error?.error?.data ||
    error?.cause?.data ||
    null
  );
}

function decodeTradeFlowError(error) {
  const data = extractErrorData(error);
  if (typeof data !== "string" || !data.startsWith("0x")) return null;

  try {
    const parsed = TRADE_FLOW_INTERFACE.parseError(data);
    const args = parsed.args || [];

    switch (parsed.name) {
      case "AccessControlUnauthorizedAccount":
        return `Access blocked: ${shortAddress(args[0])} lacks ${formatRole(args[1])}.`;
      case "RoleConflict":
        return `Segregation of duties blocked for ${shortAddress(args[1])}.`;
      case "InvalidStatus":
        return `Invalid workflow state: ${STATUS[Number(args[0])] || args[0]} -> ${STATUS[Number(args[1])] || args[1]}.`;
      case "DuplicateInvoiceHash":
        return `Duplicate invoice blocked: hash already belongs to deal ${args[1].toString()}.`;
      case "InsufficientLiquidity":
        return `Insufficient liquidity: available ${formatToken(args[0])} mUSD, required ${formatToken(args[1])} mUSD.`;
      case "NotExpired":
        return `Deal ${args[0].toString()} has not reached expiry yet.`;
      case "UnauthorizedExporter":
        return `Only the exporter can submit these documents.`;
      case "InvalidHash":
        return `Missing or empty hash value.`;
      case "ZeroAddress":
        return `Zero address is not allowed.`;
      case "InvalidAmount":
        return `Amount must be greater than zero.`;
      case "InvalidAdvanceRate":
        return `Advance rate must be between 1 and 10,000 bps.`;
      case "InvalidFee":
        return `Financing fee must be smaller than the financed amount.`;
      case "InvalidDate":
        return `Due date and expiry deadline are not valid.`;
      default:
        return `${parsed.name} reverted.`;
    }
  } catch {
    return null;
  }
}

function App() {
  const [provider, setProvider] = useState(null);
  const [signer, setSigner] = useState(null);
  const [account, setAccount] = useState("");
  const [chainId, setChainId] = useState(null);
  const [tradeFlow, setTradeFlow] = useState(null);
  const [mockUSD, setMockUSD] = useState(null);
  const [roles, setRoles] = useState([]);
  const [nextDealId, setNextDealId] = useState(1n);
  const [selectedDealId, setSelectedDealId] = useState("1");
  const [selectedDeal, setSelectedDeal] = useState(null);
  const [liquidity, setLiquidity] = useState(0n);
  const [paused, setPaused] = useState(false);
  const [busy, setBusy] = useState(false);
  const [log, setLog] = useState([]);

  const [createForm, setCreateForm] = useState({
    importer: deployment.demoAccounts?.importer || "",
    invoiceAmount: "10000",
    advanceRateBps: "8000",
    financingFee: "100",
    dueDays: "30",
    expiryDays: "7",
  });

  const [documentForm, setDocumentForm] = useState({
    invoiceText: "invoice-001",
    documentText: "bill-of-lading-001",
  });

  const [memoForm, setMemoForm] = useState({
    complianceMemo: "kyc-aml-pass",
    approvalNote: "credit-approved",
  });

  const expectedChain = BigInt(deployment.chainId ?? 31337);

  function buildContract(connection) {
    return new ethers.Contract(
      deployment.contracts.tradeFlow.address,
      deployment.contracts.tradeFlow.abi,
      connection,
    );
  }

  function buildMockContract(connection) {
    return new ethers.Contract(
      deployment.contracts.mockUSD.address,
      deployment.contracts.mockUSD.abi,
      connection,
    );
  }

  const roleCards = useMemo(
    () => [
      { label: "Admin", address: deployment.demoAccounts?.admin, icon: ShieldCheck },
      { label: "Exporter", address: deployment.demoAccounts?.exporter, fallback: "Deal-level participant", icon: FilePlus2 },
      { label: "Importer", address: deployment.demoAccounts?.importer, fallback: "Recorded counterparty", icon: ClipboardCheck },
      { label: "Compliance", address: deployment.demoAccounts?.compliance, icon: Lock },
      { label: "Credit", address: deployment.demoAccounts?.credit, icon: FileCheck2 },
      { label: "Treasury", address: deployment.demoAccounts?.treasury, icon: Banknote },
    ],
    [],
  );

  function currentActorLabel() {
    if (!account) return "System";
    const bankRoles = roles.filter((role) => role !== "Demo Exporter");
    const roleLabel = bankRoles[0] || (roles.includes("Demo Exporter") ? "Exporter" : "Connected wallet");
    return `${roleLabel} ${shortAddress(account)}`;
  }

  function addLog(type, message, txHash, actor) {
    setLog((items) => [
      {
        type,
        message,
        txHash,
        actor: actor || currentActorLabel(),
        time: new Date().toLocaleTimeString(),
      },
      ...items,
    ].slice(0, 8));
  }

  const selectedDealReady =
    Boolean(selectedDeal) &&
    selectedDeal.invoiceHash !== ZERO_HASH &&
    selectedDeal.tradeDocumentHash !== ZERO_HASH;

  async function connectWallet() {
    if (!window.ethereum) {
      addLog("error", "MetaMask is not available in this browser.");
      return;
    }

    const browserProvider = new ethers.BrowserProvider(window.ethereum);
    await browserProvider.send("eth_requestAccounts", []);
    const nextSigner = await browserProvider.getSigner();
    const nextAccount = await nextSigner.getAddress();
    const network = await browserProvider.getNetwork();

    setProvider(browserProvider);
    setSigner(nextSigner);
    setAccount(nextAccount);
    setChainId(network.chainId);
    setTradeFlow(buildContract(nextSigner));
    setMockUSD(buildMockContract(nextSigner));
    addLog("success", "Wallet connected", undefined, `Wallet ${shortAddress(nextAccount)}`);
  }

  async function bootstrapReadOnlyState() {
    if (!window.ethereum) return;

    try {
      const browserProvider = new ethers.BrowserProvider(window.ethereum);
      const network = await browserProvider.getNetwork();
      setProvider(browserProvider);
      setChainId(network.chainId);
      setTradeFlow(buildContract(browserProvider));
      setMockUSD(buildMockContract(browserProvider));
    } catch (error) {
      addLog("error", cleanError(error));
    }
  }

  async function refresh() {
    if (!tradeFlow) return;

    try {
      const [next, available, isPaused] = await Promise.all([
        tradeFlow.nextDealId(),
        tradeFlow.availableLiquidity(),
        tradeFlow.paused(),
      ]);

      setNextDealId(next);
      setLiquidity(available);
      setPaused(isPaused);

      if (account) {
        const [complianceRole, creditRole, treasuryRole, adminRole] = await Promise.all([
          tradeFlow.COMPLIANCE_ROLE(),
          tradeFlow.CREDIT_ROLE(),
          tradeFlow.TREASURY_ROLE(),
          tradeFlow.DEFAULT_ADMIN_ROLE(),
        ]);

        const checks = await Promise.all([
          tradeFlow.hasRole(adminRole, account),
          tradeFlow.hasRole(complianceRole, account),
          tradeFlow.hasRole(creditRole, account),
          tradeFlow.hasRole(treasuryRole, account),
        ]);

        const nextRoles = [];
        if (checks[0]) nextRoles.push("Admin");
        if (checks[1]) nextRoles.push("Compliance");
        if (checks[2]) nextRoles.push("Credit");
        if (checks[3]) nextRoles.push("Treasury");
        if (account.toLowerCase() === deployment.demoAccounts?.exporter?.toLowerCase()) nextRoles.push("Demo Exporter");
        setRoles(nextRoles);
      } else {
        setRoles([]);
      }

      await loadDeal(selectedDealId, next);
    } catch (error) {
      addLog("error", cleanError(error));
    }
  }

  async function loadDeal(id = selectedDealId, maxId = nextDealId) {
    if (!tradeFlow || !id) return;
    const asBigInt = BigInt(id);
    if (asBigInt <= 0n || asBigInt >= BigInt(maxId)) {
      setSelectedDeal(null);
      return;
    }

    const deal = await tradeFlow.deals(asBigInt);
    setSelectedDeal({
      exporter: deal.exporter,
      importer: deal.importer,
      status: STATUS[Number(deal.status)],
      invoiceHash: deal.invoiceHash,
      tradeDocumentHash: deal.tradeDocumentHash,
      complianceMemoHash: deal.complianceMemoHash,
      approvalNoteHash: deal.approvalNoteHash,
      invoiceAmount: deal.invoiceAmount,
      advanceRateBps: deal.advanceRateBps,
      financedAmount: deal.financedAmount,
      financingFee: deal.financingFee,
      dueDate: Number(deal.dueDate),
      expiryDeadline: Number(deal.expiryDeadline),
      createdAt: Number(deal.createdAt),
      updatedAt: Number(deal.updatedAt),
    });
  }

  async function sendTx(label, callback) {
    if (!tradeFlow || !signer || !account) {
      addLog("error", "Connect wallet first.");
      return;
    }

    setBusy(true);
    try {
      const tx = await callback();
      addLog("info", `${label}: transaction sent ${shortAddress(tx.hash)}`, tx.hash);
      await tx.wait();
      addLog("success", `${label}: confirmed`);
      await refresh();
    } catch (error) {
      addLog("error", `${label}: ${cleanError(error)}`);
    } finally {
      setBusy(false);
    }
  }

  async function createDeal() {
    if (!tradeFlow) {
      addLog("error", "Connect wallet first.");
      return;
    }
    const now = Math.floor(Date.now() / 1000);
    const dueDate = now + Number(createForm.dueDays || 30) * SECONDS_IN_DAY;
    const expiryDeadline = now + Number(createForm.expiryDays || 7) * SECONDS_IN_DAY;

    await sendTx("Create deal", () =>
      tradeFlow.createDeal(
        createForm.importer,
        ethers.parseUnits(createForm.invoiceAmount || "0", 18),
        BigInt(createForm.advanceRateBps || "0"),
        ethers.parseUnits(createForm.financingFee || "0", 18),
        BigInt(dueDate),
        BigInt(expiryDeadline),
      ),
    );
  }

  async function submitDocuments() {
    if (!tradeFlow) {
      addLog("error", "Connect wallet first.");
      return;
    }
    await sendTx("Submit documents", () =>
      tradeFlow.submitDocuments(
        BigInt(selectedDealId),
        hashText(documentForm.invoiceText),
        hashText(documentForm.documentText),
      ),
    );
  }

  async function action(label, fnName, hashSource) {
    if (!tradeFlow) {
      addLog("error", "Connect wallet first.");
      return;
    }
    const args = hashSource
      ? [BigInt(selectedDealId), hashText(hashSource)]
      : [BigInt(selectedDealId)];
    await sendTx(label, () => tradeFlow[fnName](...args));
  }

  function alternateImporterAddress() {
    const accountLower = account.toLowerCase();
    const compliance = deployment.demoAccounts?.compliance;
    const credit = deployment.demoAccounts?.credit;
    if (compliance && compliance.toLowerCase() !== accountLower) return compliance;
    if (credit && credit.toLowerCase() !== accountLower) return credit;
    return "";
  }

  async function roleMismatchDemo() {
    if (!tradeFlow) {
      addLog("error", "Connect wallet first.");
      return;
    }

    const dealId = BigInt(selectedDealId);
    const note = hashText("role-mismatch-demo");
    const fnName = roles.includes("Compliance") ? "approveCredit" : "passCompliance";
    await sendTx("Role mismatch demo", () => tradeFlow[fnName](dealId, note));
  }

  async function duplicateInvoiceDemo() {
    if (!tradeFlow) {
      addLog("error", "Connect wallet first.");
      return;
    }
    if (!selectedDealReady || !selectedDeal) {
      addLog("error", "Load a deal with submitted hashes first.");
      return;
    }

    const importer = alternateImporterAddress();
    if (!importer) {
      addLog("error", "Need a second demo account as importer.");
      return;
    }

    const now = Math.floor(Date.now() / 1000);
    const dueDate = now + Number(createForm.dueDays || 30) * SECONDS_IN_DAY;
    const expiryDeadline = now + Number(createForm.expiryDays || 7) * SECONDS_IN_DAY;

    await sendTx("Create duplicate deal", () =>
      tradeFlow.createDeal(
        importer,
        ethers.parseUnits(createForm.invoiceAmount || "0", 18),
        BigInt(createForm.advanceRateBps || "0"),
        ethers.parseUnits(createForm.financingFee || "0", 18),
        BigInt(dueDate),
        BigInt(expiryDeadline),
      ),
    );

    const duplicateDealId = (await tradeFlow.nextDealId()) - 1n;
    await sendTx("Duplicate invoice check", () =>
      tradeFlow.submitDocuments(duplicateDealId, selectedDeal.invoiceHash, selectedDeal.tradeDocumentHash),
    );
  }

  useEffect(() => {
    bootstrapReadOnlyState();
  }, []);

  useEffect(() => {
    if (!window.ethereum) return;
    const handleAccounts = () => connectWallet();
    const handleChain = () => window.location.reload();
    window.ethereum.on?.("accountsChanged", handleAccounts);
    window.ethereum.on?.("chainChanged", handleChain);
    return () => {
      window.ethereum.removeListener?.("accountsChanged", handleAccounts);
      window.ethereum.removeListener?.("chainChanged", handleChain);
    };
  }, []);

  useEffect(() => {
    refresh();
  }, [tradeFlow, account, selectedDealId]);

  useEffect(() => {
    if (nextDealId > 1n && selectedDealId === "1") {
      loadDeal("1", nextDealId);
    }
  }, [nextDealId]);

  const networkOk = chainId === null || chainId === expectedChain;
  const roleHint = roleCapability(roles, account);

  return (
    <main className="app-shell">
      <section className="topbar">
        <div className="brand-block">
          <img className="brand-logo" src={tradeflowLogo} alt="TradeFlow logo" />
          <div>
            <p className="eyebrow">TradeFlow</p>
            <h1>SME Invoice Financing Control Desk</h1>
            <p className="subtitle">Sepolia trade finance workflow with role-separated controls and on-chain audit evidence.</p>
          </div>
        </div>
        <div className="wallet-panel">
          <div className={networkOk ? "network-ok" : "network-bad"}>
            Chain {chainId ? chainId.toString() : "not connected"} / expected {expectedChain.toString()}
          </div>
          <button className="primary" onClick={connectWallet} disabled={busy}>
            <Wallet size={18} />
            {account ? shortAddress(account) : "Connect Wallet"}
          </button>
        </div>
      </section>

      <section className="control-strip">
        <Metric
          label="TradeFlow"
          value={shortAddress(deployment.contracts.tradeFlow.address)}
          href={addressExplorerUrl(deployment.contracts.tradeFlow.address)}
        />
        <Metric label="Available MockUSD" value={formatToken(liquidity)} />
        <Metric label="Next Deal ID" value={nextDealId.toString()} />
        <Metric label="System" value={paused ? "Paused" : "Active"} tone={paused ? "danger" : "good"} />
      </section>

      <section className="role-grid">
        {roleCards.map((role) => (
          <RoleCard key={role.label} role={role} active={account?.toLowerCase() === role.address?.toLowerCase()} />
        ))}
      </section>

      <section className="role-hint" aria-live="polite">
        <ShieldCheck size={18} />
        <div>
          <strong>{roleHint.title}</strong>
          <span>{roleHint.detail}</span>
        </div>
      </section>

      <section className="main-grid">
        <Panel title="New Financing Request" icon={FilePlus2}>
          <Field label="Importer address">
            <input
              value={createForm.importer}
              onChange={(event) => setCreateForm({ ...createForm, importer: event.target.value })}
            />
          </Field>
          <div className="two-col">
            <Field label="Invoice amount">
              <input
                value={createForm.invoiceAmount}
                onChange={(event) => setCreateForm({ ...createForm, invoiceAmount: event.target.value })}
              />
            </Field>
            <Field label="Advance bps">
              <input
                value={createForm.advanceRateBps}
                onChange={(event) => setCreateForm({ ...createForm, advanceRateBps: event.target.value })}
              />
            </Field>
          </div>
          <div className="two-col">
            <Field label="Financing fee">
              <input
                value={createForm.financingFee}
                onChange={(event) => setCreateForm({ ...createForm, financingFee: event.target.value })}
              />
            </Field>
            <Field label="Expiry days">
              <input
                value={createForm.expiryDays}
                onChange={(event) => setCreateForm({ ...createForm, expiryDays: event.target.value })}
              />
            </Field>
          </div>
          <button className="primary wide" onClick={createDeal} disabled={busy}>
            <FilePlus2 size={18} />
            Create Financing Application
          </button>
        </Panel>

        <Panel title="Deal Dashboard" icon={ClipboardCheck}>
          <div className="deal-selector">
            <Field label="Deal ID">
              <input value={selectedDealId} onChange={(event) => setSelectedDealId(event.target.value)} />
            </Field>
            <button className="icon-button" onClick={refresh} title="Refresh deal" disabled={busy}>
              <RefreshCw size={18} />
            </button>
          </div>

          {selectedDeal ? (
            <div className="deal-view">
              <div className="deal-header">
                <div>
                  <span className={statusClass(selectedDeal.status)}>{selectedDeal.status}</span>
                  <p>Deal #{selectedDealId}</p>
                </div>
                <strong>{formatToken(selectedDeal.financedAmount)} mUSD financed</strong>
              </div>
              <WorkflowTracker status={selectedDeal.status} />
              <div className="amount-grid">
                <MiniMetric label="Invoice" value={formatToken(selectedDeal.invoiceAmount)} />
                <MiniMetric label="Advance" value={`${Number(selectedDeal.advanceRateBps) / 100}%`} />
                <MiniMetric label="Fee" value={`${formatToken(selectedDeal.financingFee)} mUSD`} />
                <MiniMetric label="Net Disbursement" value={`${formatToken(selectedDeal.financedAmount - selectedDeal.financingFee)} mUSD`} tone="good" />
              </div>
              <KeyValue label="Exporter" value={shortAddress(selectedDeal.exporter)} />
              <KeyValue label="Importer" value={shortAddress(selectedDeal.importer)} />
              <KeyValue label="Financed amount" value={`${formatToken(selectedDeal.financedAmount)} mUSD`} />
              <KeyValue label="Invoice due" value={formatDate(selectedDeal.dueDate)} />
              <KeyValue label="Funding window" value={formatDate(selectedDeal.expiryDeadline)} />
              <KeyValue label="Invoice hash" value={selectedDeal.invoiceHash === ZERO_HASH ? "Not submitted" : shortHash(selectedDeal.invoiceHash)} />
              <KeyValue label="Document hash" value={selectedDeal.tradeDocumentHash === ZERO_HASH ? "Not submitted" : shortHash(selectedDeal.tradeDocumentHash)} />
            </div>
          ) : (
            <div className="empty-state">No deal loaded yet.</div>
          )}
        </Panel>

        <Panel title="Role Actions" icon={ShieldCheck} wide>
          <div className="role-summary">
            <span>Detected roles:</span>
            {roles.length ? roles.map((role) => <strong key={role}>{role}</strong>) : <strong>None</strong>}
          </div>

          <div className="action-columns">
            <div className="action-group">
              <h3>Exporter</h3>
              <Field label="Invoice text">
                <input
                  value={documentForm.invoiceText}
                  onChange={(event) => setDocumentForm({ ...documentForm, invoiceText: event.target.value })}
                />
              </Field>
              <Field label="Document text">
                <input
                  value={documentForm.documentText}
                  onChange={(event) => setDocumentForm({ ...documentForm, documentText: event.target.value })}
                />
              </Field>
              <button onClick={submitDocuments} disabled={busy}>
                <FileCheck2 size={17} />
                Submit Hashes
              </button>
            </div>

            <div className="action-group">
              <h3>Compliance</h3>
              <Field label="Compliance memo">
                <input
                  value={memoForm.complianceMemo}
                  onChange={(event) => setMemoForm({ ...memoForm, complianceMemo: event.target.value })}
                />
              </Field>
              <div className="button-stack">
                <button onClick={() => action("Pass compliance", "passCompliance", memoForm.complianceMemo)} disabled={busy}>
                  <CheckCircle2 size={17} />
                  Pass
                </button>
                <button onClick={() => action("Request revision", "requestRevision", memoForm.complianceMemo)} disabled={busy}>
                  <RefreshCw size={17} />
                  Revision
                </button>
                <button onClick={() => action("Freeze deal", "freezeDeal", memoForm.complianceMemo)} disabled={busy}>
                  <AlertTriangle size={17} />
                  Freeze
                </button>
                <button onClick={() => action("Reject at compliance", "rejectAtCompliance", memoForm.complianceMemo)} disabled={busy}>
                  <XCircle size={17} />
                  Reject
                </button>
              </div>
            </div>

            <div className="action-group">
              <h3>Credit</h3>
              <Field label="Approval note">
                <input
                  value={memoForm.approvalNote}
                  onChange={(event) => setMemoForm({ ...memoForm, approvalNote: event.target.value })}
                />
              </Field>
              <div className="button-stack">
                <button onClick={() => action("Approve credit", "approveCredit", memoForm.approvalNote)} disabled={busy}>
                  <ClipboardCheck size={17} />
                  Approve
                </button>
                <button onClick={() => action("Reject at credit", "rejectAtCredit", memoForm.approvalNote)} disabled={busy}>
                  <XCircle size={17} />
                  Reject
                </button>
              </div>
            </div>

            <div className="action-group">
              <h3>Treasury</h3>
              <div className="button-stack">
                <button onClick={() => action("Fund deal", "fundDeal")} disabled={busy}>
                  <Banknote size={17} />
                  Fund
                </button>
                <button onClick={() => action("Release payment", "releasePayment")} disabled={busy}>
                  <CheckCircle2 size={17} />
                  Release
                </button>
                <button onClick={() => action("Mark expired", "markExpired")} disabled={busy}>
                  <PauseCircle size={17} />
                  Expire
                </button>
              </div>
            </div>
          </div>
        </Panel>

        <Panel title="Negative Flow" icon={AlertTriangle} wide>
          <div className="button-stack">
            <button onClick={roleMismatchDemo} disabled={busy}>
              <XCircle size={17} />
              Role mismatch demo
            </button>
            <button onClick={duplicateInvoiceDemo} disabled={busy || !selectedDealReady}>
              <AlertTriangle size={17} />
              Duplicate invoice demo
            </button>
          </div>
        </Panel>

        <Panel title="Audit Trail" icon={AlertTriangle} wide>
          <div className="audit-table">
            {log.length ? (
              <>
                <div className="audit-row audit-head">
                  <span>Timestamp</span>
                  <span>Actor</span>
                  <span>Action / Result</span>
                  <span>Tx</span>
                </div>
                {log.map((item, index) => (
                  <div className={`audit-row audit-${item.type}`} key={`${item.time}-${index}`}>
                    <span>{item.time}</span>
                    <span>{item.actor}</span>
                    <strong>{item.message}</strong>
                    <span>
                      {item.txHash && txExplorerUrl(item.txHash) ? (
                        <a href={txExplorerUrl(item.txHash)} target="_blank" rel="noreferrer">
                          Etherscan
                        </a>
                      ) : item.txHash ? (
                        shortAddress(item.txHash)
                      ) : (
                        "No tx"
                      )}
                    </span>
                  </div>
                ))}
              </>
            ) : (
              <div className="empty-state">Transactions and reverts will appear here.</div>
            )}
          </div>
        </Panel>
      </section>
    </main>
  );
}

function Panel({ title, icon: Icon, children, wide = false }) {
  return (
    <section className={wide ? "panel panel-wide" : "panel"}>
      <div className="panel-title">
        <Icon size={18} />
        <h2>{title}</h2>
      </div>
      {children}
    </section>
  );
}

function Field({ label, children }) {
  return (
    <label className="field">
      <span>{label}</span>
      {children}
    </label>
  );
}

function Metric({ label, value, tone, href }) {
  const content = (
    <>
      <span>{label}</span>
      <strong>{value}</strong>
    </>
  );

  return (
    <div className={`metric metric-${tone || "neutral"}`}>
      {href ? (
        <a href={href} target="_blank" rel="noreferrer">
          {content}
          <ExternalLink size={14} />
        </a>
      ) : (
        content
      )}
    </div>
  );
}

function MiniMetric({ label, value, tone }) {
  return (
    <div className={`mini-metric mini-${tone || "neutral"}`}>
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function WorkflowTracker({ status }) {
  return (
    <div className="workflow-tracker" aria-label="Deal workflow progress">
      {WORKFLOW_STEPS.map((step) => (
        <div className={`workflow-step workflow-${workflowState(status, step)}`} key={step}>
          <span />
          <strong>{step}</strong>
        </div>
      ))}
    </div>
  );
}

function RoleCard({ role, active }) {
  const Icon = role.icon;
  const detail = role.address ? shortAddress(role.address) : role.fallback || "Not configured";
  return (
    <div className={active ? "role-card active" : "role-card"}>
      <Icon size={18} />
      <div>
        <strong>{role.label}</strong>
        <span>{detail}</span>
      </div>
    </div>
  );
}

function KeyValue({ label, value }) {
  return (
    <div className="key-value">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function shortHash(value) {
  return `${value.slice(0, 10)}...${value.slice(-8)}`;
}

function cleanError(error) {
  const decoded = decodeTradeFlowError(error);
  if (decoded) return decoded;

  const text = error?.shortMessage || error?.reason || error?.message || "Unknown error";
  return text.replace(/\s+/g, " ").slice(0, 240);
}

createRoot(document.getElementById("root")).render(<App />);
