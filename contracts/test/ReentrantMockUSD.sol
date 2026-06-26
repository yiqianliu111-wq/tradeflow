// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

interface ITokenTransferHook {
    function onTokenTransfer(address token, uint256 amount) external;
}

/// @title ReentrantMockUSD
/// @notice Test-only ERC20 that calls a recipient hook after transfer.
/// @dev This deliberately simulates hostile token behavior for payment-safety tests.
contract ReentrantMockUSD is ERC20 {
    constructor() ERC20("Reentrant Mock USD", "rUSD") {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function transfer(address to, uint256 amount) public override returns (bool) {
        bool ok = super.transfer(to, amount);
        if (to.code.length > 0) {
            try ITokenTransferHook(to).onTokenTransfer(msg.sender, amount) {} catch {}
        }
        return ok;
    }
}
