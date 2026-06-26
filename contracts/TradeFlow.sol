// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/// @title TradeFlow
/// @notice Audit-aware SME invoice financing workflow DApp.
/// @dev
/// EN: This contract intentionally models the operational and compliance control layer of SME
/// invoice financing, not a full production trade finance product. It focuses on segregation
/// of duties, state-machine sequencing, hash-only document evidence, audit events, and finite
/// MockUSD liquidity.
///
/// This scope boundary is intentional: the MVP demonstrates a testable control layer rather
/// than overstating itself as a complete credit-risk or repayment platform.
contract TradeFlow is AccessControl, Pausable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    bytes32 public constant COMPLIANCE_ROLE = keccak256("COMPLIANCE_ROLE");
    bytes32 public constant CREDIT_ROLE = keccak256("CREDIT_ROLE");
    bytes32 public constant TREASURY_ROLE = keccak256("TREASURY_ROLE");

    uint256 public constant BPS_DENOMINATOR = 10_000;

    enum DealStatus {
        Created,
        DocumentsSubmitted,
        RevisionRequested,
        CompliancePassed,
        Frozen,
        CreditApproved,
        Funded,
        PaymentReleased,
        Rejected,
        Expired
    }

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

    IERC20 public immutable mockUsd;
    uint256 public nextDealId = 1;
    uint256 public totalReserved;

    mapping(uint256 => Deal) public deals;

    /// @notice First deal id that used each invoice hash.
    /// @dev Prevents duplicate financing of the same invoice hash. The MVP uses a strict rule:
    /// once an invoice hash has been used by any deal, it cannot be reused.
    mapping(bytes32 => uint256) public invoiceHashToDealId;

    event DealCreated(
        uint256 indexed dealId,
        address indexed exporter,
        address indexed importer,
        uint256 invoiceAmount,
        uint256 financedAmount,
        uint256 dueDate,
        uint256 timestamp
    );
    event DocumentsSubmitted(
        uint256 indexed dealId,
        address indexed exporter,
        bytes32 invoiceHash,
        bytes32 tradeDocumentHash,
        uint256 timestamp
    );
    event RevisionRequested(
        uint256 indexed dealId,
        address indexed complianceOfficer,
        bytes32 complianceMemoHash,
        uint256 timestamp
    );
    event ComplianceChecked(
        uint256 indexed dealId,
        address indexed complianceOfficer,
        bool passed,
        bytes32 complianceMemoHash,
        uint256 timestamp
    );
    event DealFrozen(
        uint256 indexed dealId,
        address indexed complianceOfficer,
        bytes32 complianceMemoHash,
        uint256 timestamp
    );
    event DealRejected(
        uint256 indexed dealId,
        address indexed actor,
        DealStatus previousStatus,
        bytes32 reasonHash,
        uint256 timestamp
    );
    event CreditApproved(
        uint256 indexed dealId,
        address indexed creditOfficer,
        bytes32 approvalNoteHash,
        uint256 timestamp
    );
    event DealFunded(uint256 indexed dealId, address indexed treasury, uint256 amount, uint256 timestamp);
    event PaymentReleased(uint256 indexed dealId, address indexed exporter, uint256 amount, uint256 timestamp);
    event DealExpired(uint256 indexed dealId, address indexed actor, DealStatus previousStatus, uint256 timestamp);

    error ZeroAddress();
    error InvalidAmount();
    error InvalidAdvanceRate();
    error InvalidFee();
    error InvalidDate();
    error InvalidHash();
    error DealNotFound(uint256 dealId);
    error InvalidStatus(DealStatus current, DealStatus expected);
    error TerminalStatus(DealStatus current);
    error DuplicateInvoiceHash(bytes32 invoiceHash, uint256 existingDealId);
    error RoleConflict(bytes32 role, address account);
    error UnauthorizedExporter(address caller, address exporter);
    error InsufficientLiquidity(uint256 available, uint256 required);
    error NotExpired(uint256 dealId, uint256 expiryDeadline, uint256 timestamp);

    constructor(address mockUsd_, address admin) {
        if (mockUsd_ == address(0) || admin == address(0)) revert ZeroAddress();

        mockUsd = IERC20(mockUsd_);
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
    }

    /// @notice Enforce segregation of duties at role-grant time.
    /// @dev Preventive control: an account that clears KYC/AML risk cannot also grant final
    /// credit approval, and vice versa. The conflict is blocked when the role is granted rather
    /// than being detected later in the workflow.
    function _grantRole(bytes32 role, address account) internal override returns (bool) {
        _checkRoleConflict(role, account);
        return super._grantRole(role, account);
    }

    function grantRole(bytes32 role, address account) public override onlyRole(getRoleAdmin(role)) {
        _checkRoleConflict(role, account);
        super.grantRole(role, account);
    }

    function pause() external onlyRole(DEFAULT_ADMIN_ROLE) {
        _pause();
    }

    function unpause() external onlyRole(DEFAULT_ADMIN_ROLE) {
        _unpause();
    }

    /// @notice Create a financing application.
    /// @dev
    /// The exporter is msg.sender. The importer is recorded as invoice counterparty, but buyer
    /// repayment and default handling are intentionally out of MVP scope.
    function createDeal(
        address importer,
        uint256 invoiceAmount,
        uint256 advanceRateBps,
        uint256 financingFee,
        uint256 dueDate,
        uint256 expiryDeadline
    ) external whenNotPaused returns (uint256 dealId) {
        if (importer == address(0) || importer == msg.sender) revert ZeroAddress();
        if (invoiceAmount == 0) revert InvalidAmount();
        if (advanceRateBps == 0 || advanceRateBps > BPS_DENOMINATOR) revert InvalidAdvanceRate();
        if (expiryDeadline <= block.timestamp || dueDate <= expiryDeadline) revert InvalidDate();

        uint256 financedAmount = (invoiceAmount * advanceRateBps) / BPS_DENOMINATOR;
        if (financedAmount == 0) revert InvalidAmount();
        if (financingFee >= financedAmount) revert InvalidFee();

        dealId = nextDealId++;
        deals[dealId] = Deal({
            exporter: msg.sender,
            importer: importer,
            status: DealStatus.Created,
            invoiceHash: bytes32(0),
            tradeDocumentHash: bytes32(0),
            complianceMemoHash: bytes32(0),
            approvalNoteHash: bytes32(0),
            invoiceAmount: invoiceAmount,
            advanceRateBps: advanceRateBps,
            financedAmount: financedAmount,
            financingFee: financingFee,
            dueDate: dueDate,
            expiryDeadline: expiryDeadline,
            createdAt: uint64(block.timestamp),
            updatedAt: uint64(block.timestamp)
        });

        emit DealCreated(dealId, msg.sender, importer, invoiceAmount, financedAmount, dueDate, block.timestamp);
    }

    /// @notice Submit or resubmit off-chain document hashes.
    /// @dev
    /// Raw documents remain off-chain for privacy and banking data-governance reasons. The chain
    /// stores hashes only, giving auditors a tamper-evident reference without exposing customer
    /// documents or KYC/AML material on a public ledger.
    function submitDocuments(uint256 dealId, bytes32 invoiceHash, bytes32 tradeDocumentHash) external whenNotPaused {
        Deal storage deal = _getDeal(dealId);
        if (_expireIfNeeded(dealId, deal)) return;
        _onlyExporter(deal);

        if (deal.status != DealStatus.Created && deal.status != DealStatus.RevisionRequested) {
            revert InvalidStatus(deal.status, DealStatus.Created);
        }
        if (invoiceHash == bytes32(0) || tradeDocumentHash == bytes32(0)) revert InvalidHash();

        uint256 existingDealId = invoiceHashToDealId[invoiceHash];
        if (existingDealId != 0 && existingDealId != dealId) {
            revert DuplicateInvoiceHash(invoiceHash, existingDealId);
        }
        if (existingDealId == 0) {
            invoiceHashToDealId[invoiceHash] = dealId;
        }

        deal.invoiceHash = invoiceHash;
        deal.tradeDocumentHash = tradeDocumentHash;
        _setStatus(deal, DealStatus.DocumentsSubmitted);

        emit DocumentsSubmitted(dealId, msg.sender, invoiceHash, tradeDocumentHash, block.timestamp);
    }

    function requestRevision(uint256 dealId, bytes32 complianceMemoHash)
        external
        whenNotPaused
        onlyRole(COMPLIANCE_ROLE)
    {
        Deal storage deal = _getDeal(dealId);
        if (_expireIfNeeded(dealId, deal)) return;
        _requireStatus(deal, DealStatus.DocumentsSubmitted);
        if (complianceMemoHash == bytes32(0)) revert InvalidHash();

        deal.complianceMemoHash = complianceMemoHash;
        _setStatus(deal, DealStatus.RevisionRequested);

        emit RevisionRequested(dealId, msg.sender, complianceMemoHash, block.timestamp);
    }

    /// @notice Move a submitted deal to CompliancePassed.
    /// @dev Only a compliance officer can clear KYC/AML checks. Credit approval remains a
    /// separate later step to preserve segregation of duties.
    function passCompliance(uint256 dealId, bytes32 complianceMemoHash)
        external
        whenNotPaused
        onlyRole(COMPLIANCE_ROLE)
    {
        Deal storage deal = _getDeal(dealId);
        if (_expireIfNeeded(dealId, deal)) return;
        _requireStatus(deal, DealStatus.DocumentsSubmitted);
        if (complianceMemoHash == bytes32(0)) revert InvalidHash();

        deal.complianceMemoHash = complianceMemoHash;
        _setStatus(deal, DealStatus.CompliancePassed);

        emit ComplianceChecked(dealId, msg.sender, true, complianceMemoHash, block.timestamp);
    }

    /// @notice Freeze a submitted deal due to compliance risk.
    /// @dev Frozen is terminal in this MVP. Unfreezing a sanctions or AML-risk case would require
    /// off-chain investigation, governance, and documented approval outside this prototype.
    function freezeDeal(uint256 dealId, bytes32 complianceMemoHash)
        external
        whenNotPaused
        onlyRole(COMPLIANCE_ROLE)
    {
        Deal storage deal = _getDeal(dealId);
        if (_expireIfNeeded(dealId, deal)) return;
        _requireStatus(deal, DealStatus.DocumentsSubmitted);
        if (complianceMemoHash == bytes32(0)) revert InvalidHash();

        deal.complianceMemoHash = complianceMemoHash;
        _setStatus(deal, DealStatus.Frozen);

        emit DealFrozen(dealId, msg.sender, complianceMemoHash, block.timestamp);
    }

    /// @notice Reject a deal at the compliance stage.
    /// @dev This is distinct from Frozen: rejection means the case does not proceed, while Frozen
    /// means a risk hit requires manual investigation and should not re-enter the normal flow.
    function rejectAtCompliance(uint256 dealId, bytes32 complianceMemoHash)
        external
        whenNotPaused
        onlyRole(COMPLIANCE_ROLE)
    {
        Deal storage deal = _getDeal(dealId);
        if (_expireIfNeeded(dealId, deal)) return;
        DealStatus previousStatus = deal.status;
        _requireStatus(deal, DealStatus.DocumentsSubmitted);
        if (complianceMemoHash == bytes32(0)) revert InvalidHash();

        deal.complianceMemoHash = complianceMemoHash;
        _setStatus(deal, DealStatus.Rejected);

        emit DealRejected(dealId, msg.sender, previousStatus, complianceMemoHash, block.timestamp);
    }

    /// @notice Approve financing after compliance has passed.
    /// @dev A credit officer cannot approve until compliance has passed, preventing approval
    /// sequencing gaps and making the state machine enforce the bank control flow.
    function approveCredit(uint256 dealId, bytes32 approvalNoteHash)
        external
        whenNotPaused
        onlyRole(CREDIT_ROLE)
    {
        Deal storage deal = _getDeal(dealId);
        if (_expireIfNeeded(dealId, deal)) return;
        _requireStatus(deal, DealStatus.CompliancePassed);
        if (approvalNoteHash == bytes32(0)) revert InvalidHash();

        deal.approvalNoteHash = approvalNoteHash;
        _setStatus(deal, DealStatus.CreditApproved);

        emit CreditApproved(dealId, msg.sender, approvalNoteHash, block.timestamp);
    }

    /// @notice Reject a compliance-cleared deal on credit grounds.
    /// @dev This separates compliance rejection from credit rejection, which makes audit trails
    /// more meaningful for bank operations and risk review.
    function rejectAtCredit(uint256 dealId, bytes32 approvalNoteHash)
        external
        whenNotPaused
        onlyRole(CREDIT_ROLE)
    {
        Deal storage deal = _getDeal(dealId);
        if (_expireIfNeeded(dealId, deal)) return;
        DealStatus previousStatus = deal.status;
        _requireStatus(deal, DealStatus.CompliancePassed);
        if (approvalNoteHash == bytes32(0)) revert InvalidHash();

        deal.approvalNoteHash = approvalNoteHash;
        _setStatus(deal, DealStatus.Rejected);

        emit DealRejected(dealId, msg.sender, previousStatus, approvalNoteHash, block.timestamp);
    }

    /// @notice Reserve MockUSD from the contract liquidity pool for an approved deal.
    /// @dev This function does not mint new tokens. It checks the pre-funded contract balance and
    /// reserves liquidity, so treasury funding is constrained by a finite pool.
    function fundDeal(uint256 dealId) external whenNotPaused onlyRole(TREASURY_ROLE) {
        Deal storage deal = _getDeal(dealId);
        if (_expireIfNeeded(dealId, deal)) return;
        _requireStatus(deal, DealStatus.CreditApproved);

        uint256 available = availableLiquidity();
        if (available < deal.financedAmount) revert InsufficientLiquidity(available, deal.financedAmount);

        totalReserved += deal.financedAmount;
        _setStatus(deal, DealStatus.Funded);

        emit DealFunded(dealId, msg.sender, deal.financedAmount, block.timestamp);
    }

    /// @notice Release net financing proceeds to exporter.
    /// @dev
    /// The contract reserves the gross financed amount. The flat fee remains in the pool as a
    /// simplified bank fee. Real products would price fees from tenor, risk rating, and bank
    /// pricing policy.
    function releasePayment(uint256 dealId) external whenNotPaused onlyRole(TREASURY_ROLE) nonReentrant {
        Deal storage deal = _getDeal(dealId);
        _requireStatus(deal, DealStatus.Funded);

        uint256 grossAmount = deal.financedAmount;
        uint256 netAmount = grossAmount - deal.financingFee;

        totalReserved -= grossAmount;
        _setStatus(deal, DealStatus.PaymentReleased);
        mockUsd.safeTransfer(deal.exporter, netAmount);

        emit PaymentReleased(dealId, deal.exporter, netAmount, block.timestamp);
    }

    function markExpired(uint256 dealId) external whenNotPaused returns (bool expired) {
        Deal storage deal = _getDeal(dealId);
        if (!_isExpirable(deal.status)) revert TerminalStatus(deal.status);
        if (block.timestamp <= deal.expiryDeadline) {
            revert NotExpired(dealId, deal.expiryDeadline, block.timestamp);
        }

        DealStatus previousStatus = deal.status;
        _setStatus(deal, DealStatus.Expired);
        emit DealExpired(dealId, msg.sender, previousStatus, block.timestamp);
        return true;
    }

    function availableLiquidity() public view returns (uint256) {
        return mockUsd.balanceOf(address(this)) - totalReserved;
    }

    function disbursementAmount(uint256 dealId) external view returns (uint256) {
        Deal storage deal = _getDeal(dealId);
        return deal.financedAmount - deal.financingFee;
    }

    function isTerminalStatus(DealStatus status) public pure returns (bool) {
        return status == DealStatus.PaymentReleased
            || status == DealStatus.Rejected
            || status == DealStatus.Frozen
            || status == DealStatus.Expired;
    }

    function _checkRoleConflict(bytes32 role, address account) internal view {
        if (role == COMPLIANCE_ROLE && hasRole(CREDIT_ROLE, account)) {
            revert RoleConflict(role, account);
        }
        if (role == CREDIT_ROLE && hasRole(COMPLIANCE_ROLE, account)) {
            revert RoleConflict(role, account);
        }
    }

    function _getDeal(uint256 dealId) internal view returns (Deal storage deal) {
        if (dealId == 0 || dealId >= nextDealId) revert DealNotFound(dealId);
        return deals[dealId];
    }

    function _onlyExporter(Deal storage deal) internal view {
        if (msg.sender != deal.exporter) revert UnauthorizedExporter(msg.sender, deal.exporter);
    }

    function _requireStatus(Deal storage deal, DealStatus expected) internal view {
        if (deal.status != expected) revert InvalidStatus(deal.status, expected);
    }

    function _setStatus(Deal storage deal, DealStatus status) internal {
        deal.status = status;
        deal.updatedAt = uint64(block.timestamp);
    }

    function _expireIfNeeded(uint256 dealId, Deal storage deal) internal returns (bool) {
        if (!_isExpirable(deal.status) || block.timestamp <= deal.expiryDeadline) {
            return false;
        }

        DealStatus previousStatus = deal.status;
        _setStatus(deal, DealStatus.Expired);
        emit DealExpired(dealId, msg.sender, previousStatus, block.timestamp);
        return true;
    }

    function _isExpirable(DealStatus status) internal pure returns (bool) {
        return status == DealStatus.Created
            || status == DealStatus.DocumentsSubmitted
            || status == DealStatus.RevisionRequested
            || status == DealStatus.CompliancePassed
            || status == DealStatus.CreditApproved;
    }
}
