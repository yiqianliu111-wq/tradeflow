// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

interface ITradeFlowForReentrantTest {
    function createDeal(
        address importer,
        uint256 invoiceAmount,
        uint256 advanceRateBps,
        uint256 financingFee,
        uint256 dueDate,
        uint256 expiryDeadline
    ) external returns (uint256 dealId);

    function submitDocuments(uint256 dealId, bytes32 invoiceHash, bytes32 tradeDocumentHash) external;

    function releasePayment(uint256 dealId) external;
}

/// @title ReentrantReleaseExporter
/// @notice Test-only exporter contract that tries to re-enter TradeFlow during token receipt.
contract ReentrantReleaseExporter {
    ITradeFlowForReentrantTest public immutable tradeFlow;
    uint256 public dealId;
    uint256 public reentryTargetDealId;
    bool public reentryAttempted;
    bool public reentrySucceeded;

    constructor(address tradeFlow_) {
        tradeFlow = ITradeFlowForReentrantTest(tradeFlow_);
    }

    function createDeal(
        address importer,
        uint256 invoiceAmount,
        uint256 advanceRateBps,
        uint256 financingFee,
        uint256 dueDate,
        uint256 expiryDeadline
    ) external returns (uint256) {
        dealId = tradeFlow.createDeal(importer, invoiceAmount, advanceRateBps, financingFee, dueDate, expiryDeadline);
        return dealId;
    }

    function submitDocuments(uint256 targetDealId, bytes32 invoiceHash, bytes32 tradeDocumentHash) external {
        tradeFlow.submitDocuments(targetDealId, invoiceHash, tradeDocumentHash);
    }

    function setReentryTargetDealId(uint256 targetDealId) external {
        reentryTargetDealId = targetDealId;
    }

    function onTokenTransfer(address, uint256) external {
        if (!reentryAttempted) {
            reentryAttempted = true;
            try tradeFlow.releasePayment(reentryTargetDealId) {
                reentrySucceeded = true;
            } catch {}
        }
    }
}
