pragma experimental ABIEncoderV2;
pragma solidity 0.5.16;

// Inheritance
import "./Owned.sol";
import "./Proxyable.sol";
import "./LimitedSetup.sol";
import "./MixinResolver.sol";
import "./MixinSystemSettings.sol";
import "./interfaces/IFeePool.sol";

// Libraries
import "./SafeDecimalMath.sol";

// Internal references
import "./interfaces/IERC20.sol";
import "./interfaces/IPynth.sol";
import "./interfaces/ISystemStatus.sol";
// import "./interfaces/IPeriFinance.sol";
import "./FeePoolState.sol";
import "./FeePoolEternalStorage.sol";
import "./interfaces/IExchanger.sol";
import "./interfaces/IIssuer.sol";
import "./interfaces/IPeriFinanceState.sol";
import "./interfaces/IRewardEscrowV2.sol";
import "./interfaces/IDelegateApprovals.sol";
import "./interfaces/IRewardsDistribution.sol";
import "./interfaces/IEtherCollateralpUSD.sol";
import "./interfaces/ICollateralManager.sol";
import "./interfaces/ICrossChainManager.sol";

// https://docs.peri.finance/contracts/source/contracts/feepool
contract FeePool is Owned, Proxyable, LimitedSetup, MixinSystemSettings, IFeePool {
    using SafeMath for uint;
    using SafeDecimalMath for uint;

    // Where fees are pooled in pUSD.
    address public constant FEE_ADDRESS = 0xfeEFEEfeefEeFeefEEFEEfEeFeefEEFeeFEEFEeF;

    // pUSD currencyKey. Fees stored and paid in pUSD
    bytes32 private pUSD = "pUSD";

    // This struct represents the issuance activity that's happened in a fee period.
    struct FeePeriod {
        uint64 feePeriodId;
        uint64 startingDebtIndex;
        uint64 startTime;
        uint feesToDistribute;
        uint feesClaimed;
        uint rewardsToDistribute;
        uint rewardsClaimed;
    }

    // A staker(mintr) can claim from the previous fee period (7 days) only.
    // Fee Periods stored and managed from [0], such that [0] is always
    // the current active fee period which is not claimable until the
    // public function closeCurrentFeePeriod() is called closing the
    // current weeks collected fees. [1] is last weeks feeperiod
    uint8 public constant FEE_PERIOD_LENGTH = 2;

    FeePeriod[FEE_PERIOD_LENGTH] private _recentFeePeriods;
    uint256 private _currentFeePeriod;
    bool private _everDistributedFeeRewards;
    // bool private _everAllocatedFeeRewards;
    uint256 private _feeRewardsToBeAllocated;

    uint256 public quotaTolerance;

    /* ========== ADDRESS RESOLVER CONFIGURATION ========== */

    bytes32 private constant CONTRACT_SYSTEMSTATUS = "SystemStatus";
    // bytes32 private constant CONTRACT_PERIFINANCE = "PeriFinance";
    bytes32 private constant CONTRACT_FEEPOOLSTATE = "FeePoolState";
    bytes32 private constant CONTRACT_FEEPOOLETERNALSTORAGE = "FeePoolEternalStorage";
    bytes32 private constant CONTRACT_EXCHANGER = "Exchanger";
    bytes32 private constant CONTRACT_ISSUER = "Issuer";
    bytes32 private constant CONTRACT_PERIFINANCESTATE = "PeriFinanceState";
    bytes32 private constant CONTRACT_REWARDESCROW_V2 = "RewardEscrowV2";
    bytes32 private constant CONTRACT_DELEGATEAPPROVALS = "DelegateApprovals";
    bytes32 private constant CONTRACT_ETH_COLLATERAL_PUSD = "EtherCollateralpUSD";
    bytes32 private constant CONTRACT_COLLATERALMANAGER = "CollateralManager";
    bytes32 private constant CONTRACT_REWARDSDISTRIBUTION = "RewardsDistribution";
    bytes32 private constant CONTRACT_CROSSCHAINMANAGER = "CrossChainManager";

    /* ========== ETERNAL STORAGE CONSTANTS ========== */

    bytes32 private constant LAST_FEE_WITHDRAWAL = "last_fee_withdrawal";

    constructor(
        address payable _proxy,
        address _owner,
        address _resolver
    ) public Owned(_owner) Proxyable(_proxy) LimitedSetup(3 weeks) MixinSystemSettings(_resolver) {
        // Set our initial fee period
        _recentFeePeriodsStorage(0).feePeriodId = 1;
        _recentFeePeriodsStorage(0).startTime = uint64(now);
    }

    /* ========== VIEWS ========== */
    function resolverAddressesRequired() public view returns (bytes32[] memory addresses) {
        bytes32[] memory existingAddresses = MixinSystemSettings.resolverAddressesRequired();
        bytes32[] memory newAddresses = new bytes32[](12);
        newAddresses[0] = CONTRACT_SYSTEMSTATUS;
        // newAddresses[1] = CONTRACT_PERIFINANCE;
        newAddresses[1] = CONTRACT_FEEPOOLSTATE;
        newAddresses[2] = CONTRACT_FEEPOOLETERNALSTORAGE;
        newAddresses[3] = CONTRACT_EXCHANGER;
        newAddresses[4] = CONTRACT_ISSUER;
        newAddresses[5] = CONTRACT_PERIFINANCESTATE;
        newAddresses[6] = CONTRACT_REWARDESCROW_V2;
        newAddresses[7] = CONTRACT_DELEGATEAPPROVALS;
        newAddresses[8] = CONTRACT_ETH_COLLATERAL_PUSD;
        newAddresses[9] = CONTRACT_REWARDSDISTRIBUTION;
        newAddresses[10] = CONTRACT_COLLATERALMANAGER;
        newAddresses[11] = CONTRACT_CROSSCHAINMANAGER;
        addresses = combineArrays(existingAddresses, newAddresses);
    }

    function systemStatus() internal view returns (ISystemStatus) {
        return ISystemStatus(requireAndGetAddress(CONTRACT_SYSTEMSTATUS));
    }

    // function periFinance() internal view returns (IPeriFinance) {
    //     return IPeriFinance(requireAndGetAddress(CONTRACT_PERIFINANCE));
    // }

    function feePoolState() internal view returns (FeePoolState) {
        return FeePoolState(requireAndGetAddress(CONTRACT_FEEPOOLSTATE));
    }

    function feePoolEternalStorage() internal view returns (FeePoolEternalStorage) {
        return FeePoolEternalStorage(requireAndGetAddress(CONTRACT_FEEPOOLETERNALSTORAGE));
    }

    function exchanger() internal view returns (IExchanger) {
        return IExchanger(requireAndGetAddress(CONTRACT_EXCHANGER));
    }

    function etherCollateralpUSD() internal view returns (IEtherCollateralpUSD) {
        return IEtherCollateralpUSD(requireAndGetAddress(CONTRACT_ETH_COLLATERAL_PUSD));
    }

    function collateralManager() internal view returns (ICollateralManager) {
        return ICollateralManager(requireAndGetAddress(CONTRACT_COLLATERALMANAGER));
    }

    function crossChainManager() internal view returns (ICrossChainManager) {
        return ICrossChainManager(requireAndGetAddress(CONTRACT_CROSSCHAINMANAGER));
    }

    function issuer() internal view returns (IIssuer) {
        return IIssuer(requireAndGetAddress(CONTRACT_ISSUER));
    }

    function periFinanceState() internal view returns (IPeriFinanceState) {
        return IPeriFinanceState(requireAndGetAddress(CONTRACT_PERIFINANCESTATE));
    }

    function rewardEscrowV2() internal view returns (IRewardEscrowV2) {
        return IRewardEscrowV2(requireAndGetAddress(CONTRACT_REWARDESCROW_V2));
    }

    function delegateApprovals() internal view returns (IDelegateApprovals) {
        return IDelegateApprovals(requireAndGetAddress(CONTRACT_DELEGATEAPPROVALS));
    }

    function rewardsDistribution() internal view returns (IRewardsDistribution) {
        return IRewardsDistribution(requireAndGetAddress(CONTRACT_REWARDSDISTRIBUTION));
    }

    function issuanceRatio() external view returns (uint) {
        return getIssuanceRatio();
    }

    function feePeriodDuration() external view returns (uint) {
        return getFeePeriodDuration();
    }

    function targetThreshold() external view returns (uint) {
        return getTargetThreshold();
    }

    function recentFeePeriods(uint index)
        external
        view
        returns (
            uint64 feePeriodId,
            uint64 startingDebtIndex,
            uint64 startTime,
            uint feesToDistribute,
            uint feesClaimed,
            uint rewardsToDistribute,
            uint rewardsClaimed
        )
    {
        FeePeriod memory feePeriod = _recentFeePeriodsStorage(index);
        return (
            feePeriod.feePeriodId,
            feePeriod.startingDebtIndex,
            feePeriod.startTime,
            feePeriod.feesToDistribute,
            feePeriod.feesClaimed,
            feePeriod.rewardsToDistribute,
            feePeriod.rewardsClaimed
        );
    }

    function everDistributedFeeRewards() external view returns (bool) {
        return _everDistributedFeeRewards;
    }

    // function everAllocatedFeeRewards() external view returns (bool) {
    //     return _everAllocatedFeeRewards;
    // }

    function feeRewardsToBeAllocated() external view returns (uint) {
        // when _everDistributedFeeRewards is true, _feeRewardsToBeAllocated has the right value
        // since _recentFeePeriodsStorage(0).feesToDistribute has the fee for the current network at the moment.
        return
            _everDistributedFeeRewards || (_recentFeePeriodsStorage(0).startTime > (now - getFeePeriodDuration()))
                ? _feeRewardsToBeAllocated
                : _recentFeePeriodsStorage(0).feesToDistribute;
    }

    function _recentFeePeriodsStorage(uint index) internal view returns (FeePeriod storage) {
        return _recentFeePeriods[(_currentFeePeriod + index) % FEE_PERIOD_LENGTH];
    }

    // function _allocatedOtherNetworkFeeRewards() internal view returns (uint allocatedFeesForOtherNetworks) {
    //     uint otherNetworksShare = SafeDecimalMath.preciseUnit().sub(crossChainManager().currentNetworkDebtPercentage());

    //     allocatedFeesForOtherNetworks = _recentFeePeriodsStorage(0)
    //         .feesToDistribute
    //         .decimalToPreciseDecimal()
    //         .multiplyDecimalRoundPrecise(otherNetworksShare)
    //         .preciseDecimalToDecimal();
    // }

    /* ========== MUTATIVE FUNCTIONS ========== */

    function distributeFeeRewards(uint[] calldata feeRewards) external optionalProxy onlyDebtManager {
        require(getFeePeriodDuration() > 0, "Fee Period Duration not set");
        require(
            _recentFeePeriodsStorage(0).startTime <= (now - getFeePeriodDuration()),
            "distributing fee reward not yet available"
        );

        require(_everDistributedFeeRewards == false, "Distributing fee rewards is possible only once in a period");
        _everDistributedFeeRewards = true;

        // backup the fees from self network from last period.
        _feeRewardsToBeAllocated = _recentFeePeriodsStorage(0).feesToDistribute;

        uint totalFeeRewards;
        // Add up the fees from other networks
        for (uint i; i < feeRewards.length; i++) {
            totalFeeRewards = totalFeeRewards.add(feeRewards[i]);
        }
        // Add up the fees from self networks
        totalFeeRewards = totalFeeRewards.add(_feeRewardsToBeAllocated);

        // Set the proportionate rewards for self network
        _recentFeePeriodsStorage(0).feesToDistribute = totalFeeRewards
            .decimalToPreciseDecimal()
            .multiplyDecimalRoundPrecise(crossChainManager().currentNetworkDebtPercentage())
            .preciseDecimalToDecimal();

        if (_feeRewardsToBeAllocated > _recentFeePeriodsStorage(0).feesToDistribute) {
            // Burn the distributed rewards to other networks
            issuer().pynths(pUSD).burn(
                FEE_ADDRESS,
                _feeRewardsToBeAllocated.sub(_recentFeePeriodsStorage(0).feesToDistribute)
            );
        } else if (_feeRewardsToBeAllocated < _recentFeePeriodsStorage(0).feesToDistribute) {
            // Mint the extra rewards from other networks
            issuer().pynths(pUSD).issue(
                FEE_ADDRESS,
                _recentFeePeriodsStorage(0).feesToDistribute.sub(_feeRewardsToBeAllocated)
            );
        }

        // // If there are fees to be allocated to other networks, we need to burn them and subtract from feesToDistribute
        // if (_feeRewardsToBeAllocated > 0) {
        //     issuer().pynths(pUSD).burn(FEE_ADDRESS, _feeRewardsToBeAllocated);

        //     _feeRewardsToBeAllocated = _feeRewardsToBeAllocated;
        //     _recentFeePeriodsStorage(0).feesToDistribute = _recentFeePeriodsStorage(0).feesToDistribute.sub(
        //         _feeRewardsToBeAllocated
        //     );
        // }
    }

    // function allocateFeeRewards(uint amount) external optionalProxy onlyDebtManager {
    //     require(getFeePeriodDuration() > 0, "Fee Period Duration not set");
    //     require(
    //         _recentFeePeriodsStorage(0).startTime <= (now - getFeePeriodDuration()),
    //         "allocating fee reward not yet available"
    //     );

    //     require(_everAllocatedFeeRewards == false, "Allocating fee rewards is possible only once in a period");
    //     _everAllocatedFeeRewards = true;

    //     if (amount == 0) return;

    //     uint currentNetworkAllocatedFeeRewards =
    //         amount
    //             .decimalToPreciseDecimal()
    //             .multiplyDecimalRoundPrecise(crossChainManager().currentNetworkDebtPercentage())
    //             .preciseDecimalToDecimal();

    //     issuer().pynths(pUSD).issue(FEE_ADDRESS, currentNetworkAllocatedFeeRewards);

    //     _recentFeePeriodsStorage(0).feesToDistribute = _recentFeePeriodsStorage(0).feesToDistribute.add(
    //         currentNetworkAllocatedFeeRewards
    //     );
    // }

    /**
     * @notice Logs an accounts issuance data per fee period
     * @param account Message.Senders account address
     * @param debtRatio Debt percentage this account has locked after minting or burning their pynth
     * @param debtEntryIndex The index in the global debt ledger. periFinanceState.issuanceData(account)
     * @dev onlyIssuer to call me on periFinance.issue() & periFinance.burn() calls to store the locked PERI
     * per fee period so we know to allocate the correct proportions of fees and rewards per period
     */
    function appendAccountIssuanceRecord(
        address account,
        uint debtRatio,
        uint debtEntryIndex
    ) external onlyIssuerAndPeriFinanceState {
        feePoolState().appendAccountIssuanceRecord(
            account,
            debtRatio,
            debtEntryIndex,
            _recentFeePeriodsStorage(0).startingDebtIndex
        );

        emitIssuanceDebtRatioEntry(account, debtRatio, debtEntryIndex, _recentFeePeriodsStorage(0).startingDebtIndex);
    }

    /**
     * @notice The Exchanger contract informs us when fees are paid.
     * @param amount susd amount in fees being paid.
     */
    function recordFeePaid(uint amount) external onlyInternalContracts {
        // Keep track off fees in pUSD in the open fee pool period.
        _recentFeePeriodsStorage(0).feesToDistribute = _recentFeePeriodsStorage(0).feesToDistribute.add(amount);
    }

    /**
     * @notice The RewardsDistribution contract informs us how many PERI rewards are sent to RewardEscrow to be claimed.
     */
    function setRewardsToDistribute(uint amount) external {
        address rewardsAuthority = address(rewardsDistribution());
        require(messageSender == rewardsAuthority || msg.sender == rewardsAuthority, "Caller is not rewardsAuthority");
        // Add the amount of PERI rewards to distribute on top of any rolling unclaimed amount
        _recentFeePeriodsStorage(0).rewardsToDistribute = _recentFeePeriodsStorage(0).rewardsToDistribute.add(amount);
    }

    function setQuotaTolerance(uint _val) external onlyOwner {
        require(_val < SafeDecimalMath.unit(), "Tolerance value cannot exceeds 1");

        quotaTolerance = _val;
    }

    /**
     * @notice Fix the recent period start time.
     */
    function setRecentPeriodStartTime(uint64 _startTime) external optionalProxy onlyDebtManager {
        require(now >= _startTime, "Cannot be more than the current time");
        _recentFeePeriodsStorage(0).startTime = _startTime;
    }

    /**
     * @notice Close the current fee period and start a new one.
     */
    function closeCurrentFeePeriod() external issuanceActive {
        require(getFeePeriodDuration() > 0, "Fee Period Duration not set");
        require(_recentFeePeriodsStorage(0).startTime <= (now - getFeePeriodDuration()), "Too early to close fee period");
        require(
            _everDistributedFeeRewards ||
                crossChainManager().currentNetworkDebtPercentage() == SafeDecimalMath.preciseUnit(),
            "fee rewards should be distributed before closing period"
        );

        // Note:  when FEE_PERIOD_LENGTH = 2, periodClosing is the current period & periodToRollover is the last open claimable period
        FeePeriod storage periodClosing = _recentFeePeriodsStorage(FEE_PERIOD_LENGTH - 2);
        FeePeriod storage periodToRollover = _recentFeePeriodsStorage(FEE_PERIOD_LENGTH - 1);
        // IERC20 _perifinance = IERC20(requireAndGetAddress(CONTRACT_PERIFINANCE));

        // Any unclaimed fees from the last period in the array roll back one period.
        // Because of the subtraction here, they're effectively proportionally redistributed to those who
        // have already claimed from the old period, available in the new period.
        // The subtraction is important so we don't create a ticking time bomb of an ever growing
        // number of fees that can never decrease and will eventually overflow at the end of the fee pool.
        _recentFeePeriodsStorage(FEE_PERIOD_LENGTH - 2).feesToDistribute = periodClosing
            .feesToDistribute
            .add(periodToRollover.feesToDistribute)
            .sub(periodToRollover.feesClaimed);
        _recentFeePeriodsStorage(FEE_PERIOD_LENGTH - 2).rewardsToDistribute = periodClosing
            .rewardsToDistribute
            .add(periodToRollover.rewardsToDistribute)
            .sub(periodToRollover.rewardsClaimed);

        // _recentFeePeriodsStorage(FEE_PERIOD_LENGTH - 2).rewardsToDistribute = _perifinance
        //     .balanceOf(requireAndGetAddress(CONTRACT_REWARDESCROW_V2))
        //     .sub(rewardEscrowV2().totalEscrowedBalance());

        // Shift the previous fee periods across to make room for the new one.
        _currentFeePeriod = _currentFeePeriod.add(FEE_PERIOD_LENGTH).sub(1).mod(FEE_PERIOD_LENGTH);

        // Clear the first element of the array to make sure we don't have any stale values.
        delete _recentFeePeriods[_currentFeePeriod];

        // Open up the new fee period.
        // Increment periodId from the recent closed period feePeriodId
        _recentFeePeriodsStorage(0).feePeriodId = uint64(uint256(_recentFeePeriodsStorage(1).feePeriodId).add(1));
        _recentFeePeriodsStorage(0).startingDebtIndex = uint64(periFinanceState().debtLedgerLength());
        _recentFeePeriodsStorage(0).startTime = uint64(now);

        // allow fee rewards to be distributed when the period is closed
        _everDistributedFeeRewards = false;
        // _everAllocatedFeeRewards = false;
        emitFeePeriodClosed(_recentFeePeriodsStorage(1).feePeriodId);
    }

    /**
     * @notice Claim fees for last period when available or not already withdrawn.
     */
    function claimFees() external issuanceActive optionalProxy returns (bool) {
        return _claimFees(messageSender);
    }

    /**
     * @notice Delegated claimFees(). Call from the deletegated address
     * and the fees will be sent to the claimingForAddress.
     * approveClaimOnBehalf() must be called first to approve the deletage address
     * @param claimingForAddress The account you are claiming fees for
     */
    function claimOnBehalf(address claimingForAddress) external issuanceActive optionalProxy returns (bool) {
        require(delegateApprovals().canClaimFor(claimingForAddress, messageSender), "Not approved to claim on behalf");

        return _claimFees(claimingForAddress);
    }

    function _claimFees(address claimingAddress) internal returns (bool) {
        uint rewardsPaid = 0;
        uint feesPaid = 0;
        uint availableFees;
        uint availableRewards;

        // Address won't be able to claim fees if it is too far below the target c-ratio.
        // It will need to burn pynths then try claiming again.
        (bool feesClaimable, bool anyRateIsInvalid) = _isFeesClaimableAndAnyRatesInvalid(claimingAddress);

        require(feesClaimable, "C-Ratio below penalty threshold");

        require(!anyRateIsInvalid, "A pynth or PERI rate is invalid");

        // Get the claimingAddress available fees and rewards
        (availableFees, availableRewards) = feesAvailable(claimingAddress);

        require(
            availableFees > 0 || availableRewards > 0,
            "No fees or rewards available for period, or fees already claimed"
        );

        // Record the address has claimed for this period
        _setLastFeeWithdrawal(claimingAddress, _recentFeePeriodsStorage(1).feePeriodId);

        if (availableFees > 0) {
            // Record the fee payment in our recentFeePeriods
            feesPaid = _recordFeePayment(availableFees);

            // Send them their fees
            _payFees(claimingAddress, feesPaid);
        }

        if (availableRewards > 0) {
            // Record the reward payment in our recentFeePeriods
            rewardsPaid = _recordRewardPayment(availableRewards);

            // Send them their rewards
            _payRewards(claimingAddress, rewardsPaid);
        }

        emitFeesClaimed(claimingAddress, feesPaid, rewardsPaid);

        return true;
    }

    /**
     * @notice Admin function to import the FeePeriod data from the previous contract
     */
    /* function importFeePeriod(
        uint feePeriodIndex,
        uint feePeriodId,
        uint startingDebtIndex,
        uint startTime,
        uint feesToDistribute,
        uint feesClaimed,
        uint rewardsToDistribute,
        uint rewardsClaimed
    ) public optionalProxy_onlyOwner onlyDuringSetup {
        require(startingDebtIndex <= periFinanceState().debtLedgerLength(), "Cannot import bad data");

        _recentFeePeriods[_currentFeePeriod.add(feePeriodIndex).mod(FEE_PERIOD_LENGTH)] = FeePeriod({
            feePeriodId: uint64(feePeriodId),
            startingDebtIndex: uint64(startingDebtIndex),
            startTime: uint64(startTime),
            feesToDistribute: feesToDistribute,
            feesClaimed: feesClaimed,
            rewardsToDistribute: rewardsToDistribute,
            rewardsClaimed: rewardsClaimed
        });
    } */

    function setInitialFeePeriods(address prevFeePool) external optionalProxy_onlyOwner onlyDuringSetup {
        require(prevFeePool != address(0), "Previous FeePool address must be set");

        for (uint i; i < FEE_PERIOD_LENGTH; i++) {
            (
                uint64 feePeriodId,
                uint64 startingDebtIndex,
                uint64 startTime,
                uint feesToDistribute,
                uint feesClaimed,
                uint rewardsToDistribute,
                uint rewardsClaimed
            ) = IFeePool(prevFeePool).recentFeePeriods(i);

            _recentFeePeriodsStorage(i).feePeriodId = feePeriodId;
            _recentFeePeriodsStorage(i).startingDebtIndex = startingDebtIndex;
            _recentFeePeriodsStorage(i).startTime = startTime;
            _recentFeePeriodsStorage(i).feesToDistribute = feesToDistribute;
            _recentFeePeriodsStorage(i).feesClaimed = feesClaimed;
            _recentFeePeriodsStorage(i).rewardsToDistribute = rewardsToDistribute;
            _recentFeePeriodsStorage(i).rewardsClaimed = rewardsClaimed;
        }
    }

    /**
     * @notice Record the fee payment in our recentFeePeriods.
     * @param pUSDAmount The amount of fees priced in pUSD.
     */
    function _recordFeePayment(uint pUSDAmount) internal returns (uint feesPaid) {
        // Don't assign to the parameter
        uint remainingToAllocate = pUSDAmount;

        // Start at the oldest period and record the amount, moving to newer periods
        // until we've exhausted the amount.
        // The condition checks for overflow because we're going to 0 with an unsigned int.
        for (uint i = FEE_PERIOD_LENGTH - 1; i < FEE_PERIOD_LENGTH; i--) {
            uint feesAlreadyClaimed = _recentFeePeriodsStorage(i).feesClaimed;
            uint delta = _recentFeePeriodsStorage(i).feesToDistribute.sub(feesAlreadyClaimed);

            if (delta > 0) {
                // Take the smaller of the amount left to claim in the period and the amount we need to allocate
                uint amountInPeriod = delta < remainingToAllocate ? delta : remainingToAllocate;

                _recentFeePeriodsStorage(i).feesClaimed = feesAlreadyClaimed.add(amountInPeriod);
                remainingToAllocate = remainingToAllocate.sub(amountInPeriod);
                feesPaid = feesPaid.add(amountInPeriod);

                // No need to continue iterating if we've recorded the whole amount;
                if (remainingToAllocate == 0) return feesPaid;

                // We've exhausted feePeriods to distribute and no fees remain in last period
                // User last to claim would in this scenario have their remainder slashed
                if (i == 0 && remainingToAllocate > 0) {
                    remainingToAllocate = 0;
                }
            }
        }

        // return feesPaid;
    }

    /**
     * @notice Record the reward payment in our recentFeePeriods.
     * @param periAmount The amount of PERI tokens.
     */
    function _recordRewardPayment(uint periAmount) internal returns (uint rewardPaid) {
        // Don't assign to the parameter
        uint remainingToAllocate = periAmount;

        // uint rewardPaid;

        // Start at the oldest period and record the amount, moving to newer periods
        // until we've exhausted the amount.
        // The condition checks for overflow because we're going to 0 with an unsigned int.
        for (uint i = FEE_PERIOD_LENGTH - 1; i < FEE_PERIOD_LENGTH; i--) {
            uint toDistribute =
                _recentFeePeriodsStorage(i).rewardsToDistribute.sub(_recentFeePeriodsStorage(i).rewardsClaimed);

            if (toDistribute > 0) {
                // Take the smaller of the amount left to claim in the period and the amount we need to allocate
                uint amountInPeriod = toDistribute < remainingToAllocate ? toDistribute : remainingToAllocate;

                _recentFeePeriodsStorage(i).rewardsClaimed = _recentFeePeriodsStorage(i).rewardsClaimed.add(amountInPeriod);
                remainingToAllocate = remainingToAllocate.sub(amountInPeriod);
                rewardPaid = rewardPaid.add(amountInPeriod);

                // No need to continue iterating if we've recorded the whole amount;
                if (remainingToAllocate == 0) return rewardPaid;

                // We've exhausted feePeriods to distribute and no rewards remain in last period
                // User last to claim would in this scenario have their remainder slashed
                // due to rounding up of PreciseDecimal
                if (i == 0 && remainingToAllocate > 0) {
                    remainingToAllocate = 0;
                }
            }
        }
        // return rewardPaid;
    }

    /**
     * @notice Send the fees to claiming address.
     * @param account The address to send the fees to.
     * @param pUSDAmount The amount of fees priced in pUSD.
     */
    function _payFees(address account, uint pUSDAmount) internal notFeeAddress(account) {
        // Grab the pUSD Pynth
        IPynth pUSDPynth = issuer().pynths(pUSD);

        // NOTE: we do not control the FEE_ADDRESS so it is not possible to do an
        // ERC20.approve() transaction to allow this feePool to call ERC20.transferFrom
        // to the accounts address

        // Burn the source amount
        pUSDPynth.burn(FEE_ADDRESS, pUSDAmount);

        // Mint their new pynths
        pUSDPynth.issue(account, pUSDAmount);
    }

    /**
     * @notice Send the rewards to claiming address - will be locked in rewardEscrow.
     * @param account The address to send the fees to.
     * @param periAmount The amount of PERI.
     */
    function _payRewards(address account, uint periAmount) internal notFeeAddress(account) {
        /* Escrow the tokens for 1 year. */
        uint escrowDuration = 52 weeks;

        // Record vesting entry for claiming address and amount
        // PERI already minted to rewardEscrow balance
        rewardEscrowV2().appendVestingEntry(account, periAmount, escrowDuration);
    }

    /**
     * @notice The total fees available in the system to be withdrawnn in pUSD
     */
    function totalFeesAvailable() external view returns (uint) {
        uint totalFees = 0;

        // Fees in fee period [0] are not yet available for withdrawal
        for (uint i = 1; i < FEE_PERIOD_LENGTH; i++) {
            totalFees = totalFees.add(_recentFeePeriodsStorage(i).feesToDistribute);
            totalFees = totalFees.sub(_recentFeePeriodsStorage(i).feesClaimed);
        }

        return totalFees;
    }

    /**
     * @notice The total PERI rewards available in the system to be withdrawn
     */
    function totalRewardsAvailable() external view returns (uint totalRewards) {
        // Rewards in fee period [0] are not yet available for withdrawal
        for (uint i = 1; i < FEE_PERIOD_LENGTH; i++) {
            totalRewards = totalRewards.add(_recentFeePeriodsStorage(i).rewardsToDistribute);
            totalRewards = totalRewards.sub(_recentFeePeriodsStorage(i).rewardsClaimed);
        }
    }

    /**
     * @notice The fees available to be withdrawn by a specific account, priced in pUSD
     * @dev Returns two amounts, one for fees and one for PERI rewards
     */
    function feesAvailable(address account) public view returns (uint totalFees, uint totalRewards) {
        // Add up the fees
        uint[2][FEE_PERIOD_LENGTH] memory userFees = feesByPeriod(account);

        // Fees & Rewards in fee period [0] are not yet available for withdrawal
        for (uint i = 1; i < FEE_PERIOD_LENGTH; i++) {
            totalFees = totalFees.add(userFees[i][0]);
            totalRewards = totalRewards.add(userFees[i][1]);
        }

        // And convert totalFees to pUSD
        // Return totalRewards as is in PERI amount
        // return (totalFees, totalRewards);
    }

    function _isFeesClaimableAndAnyRatesInvalid(address account)
        internal
        view
        returns (bool feesClaimable, bool anyRateIsInvalid)
    {
        // External token staked amount should not over the quota limit.
        uint accountExternalTokenQuota = issuer().externalTokenQuota(account, 0, 0, true);
        if (
            accountExternalTokenQuota > getExternalTokenQuota().multiplyDecimal(SafeDecimalMath.unit().add(quotaTolerance))
        ) {
            return (false, false);
        }

        uint ratio;
        // Threshold is calculated from ratio % above the target ratio (issuanceRatio).
        //  0  <  10%:   Claimable
        // 10% > above:  Unable to claim
        (ratio, anyRateIsInvalid) = issuer().collateralisationRatioAndAnyRatesInvalid(account);
        uint targetRatio = getIssuanceRatio();

        feesClaimable = true;
        // Claimable if collateral ratio below target ratio
        if (ratio < targetRatio) {
            return (feesClaimable, anyRateIsInvalid);
        }

        // Calculate the threshold for collateral ratio before fees can't be claimed.
        uint ratio_threshold = targetRatio.multiplyDecimal(SafeDecimalMath.unit().add(getTargetThreshold()));

        // Not claimable if collateral ratio above threshold
        if (ratio > ratio_threshold) {
            feesClaimable = false;
        }
    }

    function isFeesClaimable(address account) external view returns (bool feesClaimable) {
        (feesClaimable, ) = _isFeesClaimableAndAnyRatesInvalid(account);
    }

    /**
     * @notice Calculates fees by period for an account, priced in pUSD
     * @param account The address you want to query the fees for
     */
    function feesByPeriod(address account) public view returns (uint[2][FEE_PERIOD_LENGTH] memory results) {
        // What's the user's debt entry index and the debt they owe to the system at current feePeriod
        uint userOwnershipPercentage;
        uint debtEntryIndex;
        FeePoolState _feePoolState = feePoolState();

        (userOwnershipPercentage, debtEntryIndex) = _feePoolState.getAccountsDebtEntry(account, 0);

        // If they don't have any debt ownership and they never minted, they don't have any fees.
        // User ownership can reduce to 0 if user burns all pynths,
        // however they could have fees applicable for periods they had minted in before so we check debtEntryIndex.
        if (debtEntryIndex == 0 && userOwnershipPercentage == 0) {
            uint[2][FEE_PERIOD_LENGTH] memory nullResults;
            return nullResults;
        }

        // The [0] fee period is not yet ready to claim, but it is a fee period that they can have
        // fees owing for, so we need to report on it anyway.
        uint feesFromPeriod;
        uint rewardsFromPeriod;
        (feesFromPeriod, rewardsFromPeriod) = _feesAndRewardsFromPeriod(0, userOwnershipPercentage, debtEntryIndex);

        results[0][0] = feesFromPeriod;
        results[0][1] = rewardsFromPeriod;

        // Retrieve user's last fee claim by periodId
        uint lastFeeWithdrawal = getLastFeeWithdrawal(account);

        // Go through our fee periods from the oldest feePeriod[FEE_PERIOD_LENGTH - 1] and figure out what we owe them.
        // Condition checks for periods > 0
        for (uint i = FEE_PERIOD_LENGTH - 1; i > 0; i--) {
            uint next = i - 1;
            uint nextPeriodStartingDebtIndex = _recentFeePeriodsStorage(next).startingDebtIndex;

            // We can skip the period, as no debt minted during period (next period's startingDebtIndex is still 0)
            if (nextPeriodStartingDebtIndex > 0 && lastFeeWithdrawal < _recentFeePeriodsStorage(i).feePeriodId) {
                // We calculate a feePeriod's closingDebtIndex by looking at the next feePeriod's startingDebtIndex
                // we can use the most recent issuanceData[0] for the current feePeriod
                // else find the applicableIssuanceData for the feePeriod based on the StartingDebtIndex of the period
                uint closingDebtIndex = uint256(nextPeriodStartingDebtIndex).sub(1);

                // Gas optimisation - to reuse debtEntryIndex if found new applicable one
                // if applicable is 0,0 (none found) we keep most recent one from issuanceData[0]
                // return if userOwnershipPercentage = 0)
                (userOwnershipPercentage, debtEntryIndex) = _feePoolState.applicableIssuanceData(account, closingDebtIndex);

                (feesFromPeriod, rewardsFromPeriod) = _feesAndRewardsFromPeriod(i, userOwnershipPercentage, debtEntryIndex);

                results[i][0] = feesFromPeriod;
                results[i][1] = rewardsFromPeriod;
            }
        }
    }

    /**
     * @notice ownershipPercentage is a high precision decimals uint based on
     * wallet's debtPercentage. Gives a precise amount of the feesToDistribute
     * for fees in the period. Precision factor is removed before results are
     * returned.
     * @dev The reported fees owing for the current period [0] are just a
     * running balance until the fee period closes
     */
    function _feesAndRewardsFromPeriod(
        uint period,
        uint ownershipPercentage,
        uint debtEntryIndex
    ) internal view returns (uint, uint) {
        // If it's zero, they haven't issued, and they have no fees OR rewards.
        if (ownershipPercentage == 0) return (0, 0);

        uint debtOwnershipForPeriod = ownershipPercentage;

        // If period has closed we want to calculate debtPercentage for the period
        if (period > 0) {
            uint closingDebtIndex = uint256(_recentFeePeriodsStorage(period - 1).startingDebtIndex).sub(1);
            debtOwnershipForPeriod = _effectiveDebtRatioForPeriod(closingDebtIndex, ownershipPercentage, debtEntryIndex);
        }

        // Calculate their percentage of the fees / rewards in this period
        // This is a high precision integer.
        uint feesFromPeriod = _recentFeePeriodsStorage(period).feesToDistribute.multiplyDecimal(debtOwnershipForPeriod);

        uint rewardsFromPeriod =
            _recentFeePeriodsStorage(period).rewardsToDistribute.multiplyDecimal(debtOwnershipForPeriod);

        return (feesFromPeriod.preciseDecimalToDecimal(), rewardsFromPeriod.preciseDecimalToDecimal());
    }

    function _effectiveDebtRatioForPeriod(
        uint closingDebtIndex,
        uint ownershipPercentage,
        uint debtEntryIndex
    ) internal view returns (uint) {
        // Figure out their global debt percentage delta at end of fee Period.
        // This is a high precision integer.
        IPeriFinanceState _periFinanceState = periFinanceState();
        uint feePeriodDebtOwnership =
            _periFinanceState
                .debtLedger(closingDebtIndex)
                .divideDecimalRoundPrecise(_periFinanceState.debtLedger(debtEntryIndex))
                .multiplyDecimalRoundPrecise(ownershipPercentage);

        return feePeriodDebtOwnership;
    }

    function effectiveDebtRatioForPeriod(address account, uint period) external view returns (uint) {
        require(period != 0, "Current period is not closed yet");
        require(period < FEE_PERIOD_LENGTH, "Exceeds the FEE_PERIOD_LENGTH");

        // If the period being checked is uninitialised then return 0. This is only at the start of the system.
        if (_recentFeePeriodsStorage(period - 1).startingDebtIndex == 0) return 0;

        uint closingDebtIndex = uint256(_recentFeePeriodsStorage(period - 1).startingDebtIndex).sub(1);

        uint ownershipPercentage;
        uint debtEntryIndex;
        (ownershipPercentage, debtEntryIndex) = feePoolState().applicableIssuanceData(account, closingDebtIndex);

        // internal function will check closingDebtIndex has corresponding debtLedger entry
        return _effectiveDebtRatioForPeriod(closingDebtIndex, ownershipPercentage, debtEntryIndex);
    }

    /**
     * @notice Get the feePeriodID of the last claim this account made
     * @param _claimingAddress account to check the last fee period ID claim for
     * @return uint of the feePeriodID this account last claimed
     */
    function getLastFeeWithdrawal(address _claimingAddress) public view returns (uint) {
        return feePoolEternalStorage().getUIntValue(keccak256(abi.encodePacked(LAST_FEE_WITHDRAWAL, _claimingAddress)));
    }

    /**
     * @notice Calculate the collateral ratio before user is blocked from claiming.
     */
    function getPenaltyThresholdRatio() public view returns (uint) {
        return getIssuanceRatio().multiplyDecimal(SafeDecimalMath.unit().add(getTargetThreshold()));
    }

    /**
     * @notice Set the feePeriodID of the last claim this account made
     * @param _claimingAddress account to set the last feePeriodID claim for
     * @param _feePeriodID the feePeriodID this account claimed fees for
     */
    function _setLastFeeWithdrawal(address _claimingAddress, uint _feePeriodID) internal {
        feePoolEternalStorage().setUIntValue(
            keccak256(abi.encodePacked(LAST_FEE_WITHDRAWAL, _claimingAddress)),
            _feePeriodID
        );
    }

    function _debtManager() internal view returns (address) {
        return crossChainManager().debtManager();
    }

    /* ========== Modifiers ========== */
    modifier onlyInternalContracts {
        bool isExchanger = msg.sender == address(exchanger());
        bool isPynth = issuer().pynthsByAddress(msg.sender) != bytes32(0);
        bool isEtherCollateralpUSD = msg.sender == address(etherCollateralpUSD());
        bool isCollateral = collateralManager().hasCollateral(msg.sender);

        require(isExchanger || isPynth || isEtherCollateralpUSD || isCollateral, "Only Internal Contracts");
        _;
    }

    modifier onlyIssuerAndPeriFinanceState {
        bool isIssuer = msg.sender == address(issuer());
        bool isPeriFinanceState = msg.sender == address(periFinanceState());
        require(isIssuer || isPeriFinanceState, "Issuer and PeriFinanceState only");
        _;
    }

    modifier onlyDebtManager {
        bool isDebtManager = messageSender == _debtManager();
        require(isDebtManager, "debt manager only");
        _;
    }

    modifier notFeeAddress(address account) {
        require(account != FEE_ADDRESS, "Fee address not allowed");
        _;
    }

    modifier issuanceActive() {
        systemStatus().requireIssuanceActive();
        _;
    }

    /* ========== Proxy Events ========== */

    event IssuanceDebtRatioEntry(
        address indexed account,
        uint debtRatio,
        uint debtEntryIndex,
        uint feePeriodStartingDebtIndex
    );
    bytes32 private constant ISSUANCEDEBTRATIOENTRY_SIG =
        keccak256("IssuanceDebtRatioEntry(address,uint256,uint256,uint256)");

    function emitIssuanceDebtRatioEntry(
        address account,
        uint debtRatio,
        uint debtEntryIndex,
        uint feePeriodStartingDebtIndex
    ) internal {
        proxy._emit(
            abi.encode(debtRatio, debtEntryIndex, feePeriodStartingDebtIndex),
            2,
            ISSUANCEDEBTRATIOENTRY_SIG,
            bytes32(uint256(uint160(account))),
            0,
            0
        );
    }

    event FeePeriodClosed(uint feePeriodId);
    bytes32 private constant FEEPERIODCLOSED_SIG = keccak256("FeePeriodClosed(uint256)");

    function emitFeePeriodClosed(uint feePeriodId) internal {
        proxy._emit(abi.encode(feePeriodId), 1, FEEPERIODCLOSED_SIG, 0, 0, 0);
    }

    event FeesClaimed(address account, uint pUSDAmount, uint periRewards);
    bytes32 private constant FEESCLAIMED_SIG = keccak256("FeesClaimed(address,uint256,uint256)");

    function emitFeesClaimed(
        address account,
        uint pUSDAmount,
        uint periRewards
    ) internal {
        proxy._emit(abi.encode(account, pUSDAmount, periRewards), 1, FEESCLAIMED_SIG, 0, 0, 0);
    }
}
