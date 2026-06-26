// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @title MockUSD
/// @notice A simple ERC20 token used only for Sepolia/local testing.
/// @dev This token simulates tokenised cash/stablecoin settlement. It has no real value
/// and should never be represented as a real deposit, stablecoin, or bank liability.
contract MockUSD is ERC20, AccessControl {
    bytes32 public constant MINTER_ROLE = keccak256("MINTER_ROLE");

    error ZeroAddress();

    constructor(address admin) ERC20("Mock USD", "mUSD") {
        if (admin == address(0)) revert ZeroAddress();

        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(MINTER_ROLE, admin);
    }

    /// @notice Mint mock settlement tokens for demos and tests.
    /// @dev Production banking systems should not mint settlement assets from workflow actions.
    /// TradeFlow seeds a finite test liquidity pool before funding deals.
    function mint(address to, uint256 amount) external onlyRole(MINTER_ROLE) {
        if (to == address(0)) revert ZeroAddress();
        _mint(to, amount);
    }
}
