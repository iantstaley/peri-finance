'use strict';

const { artifacts, contract, web3 } = require('hardhat');

const { assert, addSnapshotBeforeRestoreAfterEach } = require('./common');

const BN = require('bn.js');

const { fastForward, getEthBalance, toUnit, fromUnit, currentTime } = require('../utils')();

const { setupAllContracts, setupContract } = require('./setup');

const { ensureOnlyExpectedMutativeFunctions, setStatus } = require('./helpers');

const {
	toBytes32,
	constants: { ZERO_ADDRESS },
} = require('../..');

let CollateralManager;
let CollateralState;
let CollateralManagerState;

contract('CollateralEth', async accounts => {
	const YEAR = 31556926;
	const INTERACTION_DELAY = 300;

	const pUSD = toBytes32('pUSD');
	const pETH = toBytes32('pETH');

	const oneETH = toUnit(1);
	const twoETH = toUnit(2);
	const fiveETH = toUnit(5);
	const tenETH = toUnit(10);
	const twentyETH = toUnit(20);

	const onepUSD = toUnit(1);
	const tenpUSD = toUnit(10);
	const oneHundredpUSD = toUnit(100);
	const fiveHundredSUSD = toUnit(500);

	let tx;
	let loan;
	let id;

	const [deployerAccount, owner, oracle, , account1, account2] = accounts;

	let ceth,
		state,
		managerState,
		manager,
		issuer,
		pynths,
		feePool,
		exchangeRates,
		addressResolver,
		pUSDPynth,
		pETHPynth,
		systemStatus,
		debtCache,
		FEE_ADDRESS;

	const getid = tx => {
		const event = tx.logs.find(log => log.event === 'LoanCreated');
		return event.args.id;
	};

	const issuepUSDToAccount = async (issueAmount, receiver) => {
		// Set up the depositor with an amount of pynths to deposit.
		await pUSDPynth.issue(receiver, issueAmount, {
			from: owner,
		});
	};

	const issuepETHToAccount = async (issueAmount, receiver) => {
		await pETHPynth.issue(receiver, issueAmount, { from: owner });
	};

	const deployCollateral = async ({
		state,
		owner,
		manager,
		resolver,
		collatKey,
		minColat,
		minSize,
	}) => {
		return setupContract({
			accounts,
			contract: 'CollateralEth',
			args: [state, owner, manager, resolver, collatKey, minColat, minSize],
		});
	};

	const setupMultiCollateral = async () => {
		pynths = ['pUSD', 'pETH'];
		({
			SystemStatus: systemStatus,
			ExchangeRates: exchangeRates,
			PynthpUSD: pUSDPynth,
			PynthpETH: pETHPynth,
			FeePool: feePool,
			AddressResolver: addressResolver,
			Issuer: issuer,
			DebtCache: debtCache,
		} = await setupAllContracts({
			accounts,
			pynths,
			contracts: [
				'AddressResolver',
				'PeriFinance',
				'FeePool',
				'ExchangeRates',
				'Exchanger',
				'SystemStatus',
				'Issuer',
				'DebtCache',
			],
		}));

		managerState = await CollateralManagerState.new(owner, ZERO_ADDRESS, { from: deployerAccount });

		const maxDebt = toUnit(10000000);

		manager = await CollateralManager.new(
			managerState.address,
			owner,
			addressResolver.address,
			maxDebt,
			0,
			0,
			{
				from: deployerAccount,
			}
		);

		await managerState.setAssociatedContract(manager.address, { from: owner });

		FEE_ADDRESS = await feePool.FEE_ADDRESS();

		state = await CollateralState.new(owner, ZERO_ADDRESS, { from: deployerAccount });

		ceth = await deployCollateral({
			state: state.address,
			owner: owner,
			manager: manager.address,
			resolver: addressResolver.address,
			collatKey: pETH,
			minColat: toUnit('1.3'),
			minSize: toUnit('2'),
		});

		await state.setAssociatedContract(ceth.address, { from: owner });

		await addressResolver.importAddresses(
			[toBytes32('CollateralEth'), toBytes32('CollateralManager')],
			[ceth.address, manager.address],
			{
				from: owner,
			}
		);

		await ceth.rebuildCache();
		await manager.rebuildCache();
		await debtCache.rebuildCache();
		await feePool.rebuildCache();
		await issuer.rebuildCache();

		await manager.addCollaterals([ceth.address], { from: owner });

		await ceth.addPynths(
			['PynthpUSD', 'PynthpETH'].map(toBytes32),
			['pUSD', 'pETH'].map(toBytes32),
			{ from: owner }
		);

		await manager.addPynths(
			['PynthpUSD', 'PynthpETH'].map(toBytes32),
			['pUSD', 'pETH'].map(toBytes32),
			{ from: owner }
		);
		// rebuild the cache to add the pynths we need.
		await manager.rebuildCache();

		await ceth.setIssueFeeRate(toUnit('0.001'), { from: owner });
	};

	const updateRatesWithDefaults = async () => {
		const timestamp = await currentTime();

		await exchangeRates.updateRates([pETH], ['100'].map(toUnit), timestamp, {
			from: oracle,
		});

		const pBTC = toBytes32('pBTC');

		await exchangeRates.updateRates([pBTC], ['10000'].map(toUnit), timestamp, {
			from: oracle,
		});
	};

	const fastForwardAndUpdateRates = async seconds => {
		await fastForward(seconds);
		await updateRatesWithDefaults();
	};

	before(async () => {
		CollateralManager = artifacts.require(`CollateralManager`);
		CollateralState = artifacts.require(`CollateralState`);
		CollateralManagerState = artifacts.require('CollateralManagerState');

		await setupMultiCollateral();
	});

	addSnapshotBeforeRestoreAfterEach();

	beforeEach(async () => {
		await updateRatesWithDefaults();

		await issuepUSDToAccount(toUnit(1000), owner);
		await issuepETHToAccount(toUnit(10), owner);

		await debtCache.takeDebtSnapshot();
	});

	it('should set constructor params on deployment', async () => {
		// assert.equal(await ceth.proxy(), account1);
		assert.equal(await ceth.state(), state.address);
		assert.equal(await ceth.owner(), owner);
		assert.equal(await ceth.resolver(), addressResolver.address);
		assert.equal(await ceth.collateralKey(), pETH);
		assert.equal(await ceth.pynths(0), toBytes32('PynthpUSD'));
		assert.equal(await ceth.pynths(1), toBytes32('PynthpETH'));
		assert.bnEqual(await ceth.minCratio(), toUnit('1.3'));
		assert.bnEqual(await ceth.minCollateral(), toUnit('2'));
	});

	it('should ensure only expected functions are mutative', async () => {
		ensureOnlyExpectedMutativeFunctions({
			abi: ceth.abi,
			ignoreParents: ['Owned', 'Pausable', 'MixinResolver', 'Proxy', 'Collateral'],
			expected: ['open', 'close', 'deposit', 'repay', 'withdraw', 'liquidate', 'claim', 'draw'],
		});
	});

	it('should access its dependencies via the address resolver', async () => {
		assert.equal(await addressResolver.getAddress(toBytes32('PynthpUSD')), pUSDPynth.address);
		assert.equal(await addressResolver.getAddress(toBytes32('FeePool')), feePool.address);
		assert.equal(
			await addressResolver.getAddress(toBytes32('ExchangeRates')),
			exchangeRates.address
		);
	});

	// PUBLIC VIEW TESTS

	describe('cratio test', async () => {
		describe('pUSD loans', async () => {
			beforeEach(async () => {
				tx = await ceth.open(oneHundredpUSD, pUSD, {
					value: twoETH,
					from: account1,
				});

				id = getid(tx);
				loan = await state.getLoan(account1, id);
			});

			it('when we issue at 200%, our c ratio is 200%', async () => {
				const ratio = await ceth.collateralRatio(loan);
				assert.bnEqual(ratio, toUnit(2));
			});

			it('when the price falls by 25% our c ratio is 150%', async () => {
				await exchangeRates.updateRates([pETH], ['75'].map(toUnit), await currentTime(), {
					from: oracle,
				});

				const ratio = await ceth.collateralRatio(loan);
				assert.bnEqual(ratio, toUnit(1.5));
			});

			it('when the price increases by 100% our c ratio is 400%', async () => {
				await exchangeRates.updateRates([pETH], ['200'].map(toUnit), await currentTime(), {
					from: oracle,
				});

				const ratio = await ceth.collateralRatio(loan);
				assert.bnEqual(ratio, toUnit(4));
			});

			it('when the price falls by 50% our cratio is 100%', async () => {
				await exchangeRates.updateRates([pETH], ['50'].map(toUnit), await currentTime(), {
					from: oracle,
				});

				const ratio = await ceth.collateralRatio(loan);
				assert.bnEqual(ratio, toUnit(1));
			});
		});
		describe('pETH loans', async () => {
			beforeEach(async () => {
				tx = await ceth.open(oneETH, pETH, {
					value: twoETH,
					from: account1,
				});

				id = getid(tx);
				loan = await state.getLoan(account1, id);
			});

			it('when we issue at 200%, our c ratio is 200%', async () => {
				const ratio = await ceth.collateralRatio(loan);
				assert.bnEqual(ratio, toUnit(2));
			});

			it('price changes should not change the cratio', async () => {
				await exchangeRates.updateRates([pETH], ['75'].map(toUnit), await currentTime(), {
					from: oracle,
				});

				const ratio = await ceth.collateralRatio(loan);
				assert.bnEqual(ratio, toUnit(2));
			});
		});
	});

	describe('max loan test', async () => {
		it('should convert correctly', async () => {
			// $260 worth of eth should allow 200 pUSD to be issued.
			const pUSDAmount = await ceth.maxLoan(toUnit('2.6'), pUSD);

			assert.bnClose(pUSDAmount, toUnit('200'), '100');

			// $260 worth of eth should allow $200 (0.02) of pBTC to be issued.
			const pBTCAmount = await ceth.maxLoan(toUnit('2.6'), toBytes32('pBTC'));

			assert.bnEqual(pBTCAmount, toUnit('0.02'));
		});
	});

	describe('liquidation amount test', async () => {
		let amountToLiquidate;

		/**
		 * r = target issuance ratio
		 * D = debt balance in pUSD
		 * V = Collateral VALUE in pUSD
		 * P = liquidation penalty
		 * Calculates amount of pUSD = (D - V * r) / (1 - (1 + P) * r)
		 *
		 * To go back to another pynth, remember to do effective value
		 */

		beforeEach(async () => {
			tx = await ceth.open(oneHundredpUSD, pUSD, {
				value: twoETH,
				from: account1,
			});

			id = getid(tx);
			loan = await state.getLoan(account1, id);
		});

		it('when we start at 200%, we can take a 35% reduction in collateral prices', async () => {
			await exchangeRates.updateRates([pETH], ['65'].map(toUnit), await currentTime(), {
				from: oracle,
			});

			amountToLiquidate = await ceth.liquidationAmount(loan);

			assert.bnEqual(amountToLiquidate, toUnit(0));
		});

		it('when we start at 200%, a price shock of 40% in the collateral requires 50% of the loan to be liquidated', async () => {
			await exchangeRates.updateRates([pETH], ['60'].map(toUnit), await currentTime(), {
				from: oracle,
			});

			amountToLiquidate = await ceth.liquidationAmount(loan);

			assert.bnClose(amountToLiquidate, toUnit(50), '1000');
		});

		it('when we start at 200%, a price shock of 50% in the collateral requires the whole loan to be liquidated', async () => {
			await exchangeRates.updateRates([pETH], ['50'].map(toUnit), await currentTime(), {
				from: oracle,
			});

			amountToLiquidate = await ceth.liquidationAmount(loan);

			assert.bnGt(amountToLiquidate, toUnit(100));
		});

		it('when we start at 130%, any reduction in collateral will make the position undercollateralised ', async () => {
			tx = await ceth.open(toUnit('200'), pUSD, {
				value: toUnit('2.6'),
				from: account1,
			});

			id = getid(tx);
			loan = await state.getLoan(account1, id);

			await exchangeRates.updateRates([pETH], ['99'].map(toUnit), await currentTime(), {
				from: oracle,
			});

			amountToLiquidate = await ceth.liquidationAmount(loan);

			assert.bnGt(amountToLiquidate, 0);
		});
	});

	describe('collateral redeemed test', async () => {
		let collateralRedeemed;

		it('when ETH is @ $100 and we are liquidating 10 pUSD, then redeem 0.11 ETH', async () => {
			collateralRedeemed = await ceth.collateralRedeemed(pUSD, tenpUSD);

			assert.bnEqual(collateralRedeemed, toUnit(0.11));
		});

		it('when ETH is @ $200 and we are liquidating 10 pUSD, then redeem 0.055 ETH', async () => {
			await exchangeRates.updateRates([pETH], ['200'].map(toUnit), await currentTime(), {
				from: oracle,
			});

			collateralRedeemed = await ceth.collateralRedeemed(pUSD, tenpUSD);

			assert.bnEqual(collateralRedeemed, toUnit(0.055));
		});

		it('when ETH is @ $70 and we are liquidating 25 pUSD, then redeem 0.36666 ETH', async () => {
			await exchangeRates.updateRates([pETH], ['70'].map(toUnit), await currentTime(), {
				from: oracle,
			});

			collateralRedeemed = await ceth.collateralRedeemed(pUSD, toUnit(25));

			assert.bnClose(collateralRedeemed, toUnit(0.392857142857142857), '100');
		});

		it('regardless of eth price, we liquidate 1.1 * amount when doing pETH', async () => {
			collateralRedeemed = await ceth.collateralRedeemed(pETH, oneETH);

			assert.bnEqual(collateralRedeemed, toUnit(1.1));

			await exchangeRates.updateRates([pETH], ['1000'].map(toUnit), await currentTime(), {
				from: oracle,
			});

			collateralRedeemed = await ceth.collateralRedeemed(pETH, oneETH);

			assert.bnEqual(collateralRedeemed, toUnit(1.1));
		});
	});

	// END PUBLIC VIEW TESTS

	// SETTER TESTS

	describe('setting variables', async () => {
		describe('setMinCratio', async () => {
			describe('revert condtions', async () => {
				it('should fail if not called by the owner', async () => {
					await assert.revert(
						ceth.setMinCratio(toUnit(1), { from: account1 }),
						'Only the contract owner may perform this action'
					);
				});
				it('should fail if the minimum is less than 1', async () => {
					await assert.revert(
						ceth.setMinCratio(toUnit(0.99), { from: owner }),
						'Must be greater than 1'
					);
				});
			});
			describe('when it succeeds', async () => {
				beforeEach(async () => {
					await ceth.setMinCratio(toUnit(2), { from: owner });
				});
				it('should update the minimum collateralisation', async () => {
					assert.bnEqual(await ceth.minCratio(), toUnit(2));
				});
			});
		});

		describe('setIssueFeeRate', async () => {
			describe('revert condtions', async () => {
				it('should fail if not called by the owner', async () => {
					await assert.revert(
						ceth.setIssueFeeRate(toUnit(1), { from: account1 }),
						'Only the contract owner may perform this action'
					);
				});
			});
			describe('when it succeeds', async () => {
				beforeEach(async () => {
					await ceth.setIssueFeeRate(toUnit(0.2), { from: owner });
				});
				it('should update the liquidation penalty', async () => {
					assert.bnEqual(await ceth.issueFeeRate(), toUnit(0.2));
				});
				it('should allow the issue fee rate to be  0', async () => {
					await ceth.setIssueFeeRate(toUnit(0), { from: owner });
					assert.bnEqual(await ceth.issueFeeRate(), toUnit(0));
				});
			});
		});

		describe('setInteractionDelay', async () => {
			describe('revert condtions', async () => {
				it('should fail if not called by the owner', async () => {
					await assert.revert(
						ceth.setInteractionDelay(toUnit(1), { from: account1 }),
						'Only the contract owner may perform this action'
					);
				});
				it('should fail if the owner passes to big of a value', async () => {
					await assert.revert(
						ceth.setInteractionDelay(toUnit(3601), { from: owner }),
						'Max 1 hour'
					);
				});
			});
			describe('when it succeeds', async () => {
				beforeEach(async () => {
					await ceth.setInteractionDelay(toUnit(50), { from: owner });
				});
				it('should update the interaction delay', async () => {
					assert.bnEqual(await ceth.interactionDelay(), toUnit(50));
				});
			});
		});

		describe('setManager', async () => {
			describe('revert condtions', async () => {
				it('should fail if not called by the owner', async () => {
					await assert.revert(
						ceth.setManager(ZERO_ADDRESS, { from: account1 }),
						'Only the contract owner may perform this action'
					);
				});
			});
			describe('when it succeeds', async () => {
				beforeEach(async () => {
					await ceth.setManager(ZERO_ADDRESS, { from: owner });
				});
				it('should update the manager', async () => {
					assert.bnEqual(await ceth.manager(), ZERO_ADDRESS);
				});
			});
		});

		describe('setCanOpenLoans', async () => {
			describe('revert condtions', async () => {
				it('should fail if not called by the owner', async () => {
					await assert.revert(
						ceth.setCanOpenLoans(false, { from: account1 }),
						'Only the contract owner may perform this action'
					);
				});
			});
			describe('when it succeeds', async () => {
				beforeEach(async () => {
					await ceth.setCanOpenLoans(false, { from: owner });
				});
				it('should update the manager', async () => {
					assert.isFalse(await ceth.canOpenLoans());
				});
			});
		});
	});

	// LOAN INTERACTIONS

	describe('opening', async () => {
		describe('potential blocking conditions', async () => {
			['System', 'Issuance'].forEach(section => {
				describe(`when ${section} is suspended`, () => {
					beforeEach(async () => {
						await setStatus({ owner, systemStatus, section, suspend: true });
					});
					it('then calling openLoan() reverts', async () => {
						await assert.revert(
							ceth.open(onepUSD, pUSD, { value: twoETH, from: account1 }),
							'Operation prohibited'
						);
					});
					describe(`when ${section} is resumed`, () => {
						beforeEach(async () => {
							await setStatus({ owner, systemStatus, section, suspend: false });
						});
						it('then calling openLoan() succeeds', async () => {
							await ceth.open(onepUSD, pUSD, {
								value: twoETH,
								from: account1,
							});
						});
					});
				});
			});
			describe('when rates have gone stale', () => {
				beforeEach(async () => {
					await fastForward((await exchangeRates.rateStalePeriod()).add(web3.utils.toBN('300')));
				});
				it('then calling openLoan() reverts', async () => {
					await assert.revert(
						ceth.open(onepUSD, pUSD, { value: twoETH, from: account1 }),
						'Collateral rate is invalid'
					);
				});
				describe('when ETH gets a rate', () => {
					beforeEach(async () => {
						await updateRatesWithDefaults();
					});
					it('then calling openLoan() succeeds', async () => {
						await ceth.open(onepUSD, pUSD, { value: twoETH, from: account1 });
					});
				});
			});
		});

		describe('revert conditions', async () => {
			it('should revert if they request a currency that is not supported', async () => {
				await assert.revert(
					ceth.open(onepUSD, toBytes32('pJPY'), { value: twoETH, from: account1 }),
					'Not allowed to issue this pynth'
				);
			});

			it('should revert if they send 0 collateral', async () => {
				await assert.revert(
					ceth.open(onepUSD, pUSD, { value: oneETH, from: account1 }),
					'Not enough collateral to open'
				);
			});

			it('should revert if the requested loan exceeds borrowing power', async () => {
				await assert.revert(
					ceth.open(fiveHundredSUSD, pUSD, { value: twoETH, from: account1 }),
					'Exceeds max borrowing power'
				);
			});
		});

		describe('should open an eth loan denominated in pUSD', async () => {
			beforeEach(async () => {
				tx = await ceth.open(fiveHundredSUSD, pUSD, {
					value: tenETH,
					from: account1,
				});

				id = getid(tx);

				loan = await state.getLoan(account1, id);
			});

			it('should set the loan correctly', async () => {
				assert.equal(loan.account, account1);
				assert.equal(loan.collateral, tenETH.toString());
				assert.equal(loan.currency, pUSD);
				assert.equal(loan.amount, fiveHundredSUSD.toString());
				assert.equal(loan.accruedInterest, toUnit(0));
			});

			it('should issue the correct amount to the borrower', async () => {
				// 0.001 issue fee rate.
				const expectedBal = toUnit('499.5');

				assert.bnEqual(await pUSDPynth.balanceOf(account1), expectedBal);
			});

			it('should issue the minting fee to the fee pool', async () => {
				const feePoolBalance = await pUSDPynth.balanceOf(FEE_ADDRESS);

				assert.bnEqual(toUnit('0.5'), feePoolBalance);
			});

			it('should emit the event properly', async () => {
				assert.eventEqual(tx, 'LoanCreated', {
					account: account1,
					id: id,
					amount: fiveHundredSUSD,
					collateral: tenETH,
					currency: pUSD,
				});
			});
		});

		describe('should open an eth loan denominated in pETH', async () => {
			beforeEach(async () => {
				tx = await ceth.open(fiveETH, pETH, {
					value: tenETH,
					from: account1,
				});

				id = getid(tx);

				loan = await state.getLoan(account1, id);
			});

			it('should set the loan correctly', async () => {
				assert.equal(loan.account, account1);
				assert.equal(loan.collateral, tenETH.toString());
				assert.equal(loan.currency, pETH);
				assert.equal(loan.amount, fiveETH.toString());
				assert.equal(loan.accruedInterest, toUnit(0));
			});

			it('should issue the correct amount to the borrower', async () => {
				// 0.001 issue fee rate.
				const expecetdBalance = toUnit('4.995');

				assert.bnEqual(await pETHPynth.balanceOf(account1), expecetdBalance);
			});

			it('should issue the minting fee to the fee pool', async () => {
				const feePoolBalance = await pUSDPynth.balanceOf(FEE_ADDRESS);
				// usd equivalent of 0.005 ETH @ $100 per ETH.
				assert.bnEqual(toUnit('0.5'), feePoolBalance);
			});

			it('should emit the event properly', async () => {
				assert.eventEqual(tx, 'LoanCreated', {
					account: account1,
					id: id,
					amount: fiveETH,
					collateral: tenETH,
					currency: pETH,
				});
			});
		});
	});

	describe('deposits', async () => {
		beforeEach(async () => {
			tx = await ceth.open(100, pUSD, {
				value: tenETH,
				from: account1,
			});

			id = getid(tx);

			await fastForwardAndUpdateRates(INTERACTION_DELAY);
		});

		describe('potential blocking conditions', async () => {
			['System', 'Issuance'].forEach(section => {
				describe(`when ${section} is suspended`, () => {
					beforeEach(async () => {
						await setStatus({ owner, systemStatus, section, suspend: true });
					});
					it('then calling depopsit() reverts', async () => {
						await assert.revert(
							ceth.deposit(account1, id, { value: tenETH, from: account1 }),
							'Operation prohibited'
						);
					});
					describe(`when ${section} is resumed`, () => {
						beforeEach(async () => {
							await setStatus({ owner, systemStatus, section, suspend: false });
						});
						it('then calling deposit() succeeds', async () => {
							await ceth.deposit(account1, id, { value: tenETH, from: account1 });
						});
					});
				});
			});
		});

		describe('revert conditions', async () => {
			it('should revert if they do not send any eth', async () => {
				await assert.revert(
					ceth.deposit(account1, id, { value: 0, from: account1 }),
					'Deposit must be greater than 0'
				);
			});
		});

		describe('should allow deposits', async () => {
			beforeEach(async () => {
				await ceth.deposit(account1, id, { value: tenETH, from: account1 });
			});

			it('should increase the total collateral of the loan', async () => {
				loan = await state.getLoan(account1, id);

				assert.bnEqual(loan.collateral, twentyETH);
			});
		});
	});

	describe('withdraws', async () => {
		beforeEach(async () => {
			loan = await ceth.open(oneHundredpUSD, pUSD, {
				value: tenETH,
				from: account1,
			});

			id = getid(loan);

			await fastForwardAndUpdateRates(INTERACTION_DELAY);
		});

		describe('potential blocking conditions', async () => {
			['System', 'Issuance'].forEach(section => {
				describe(`when ${section} is suspended`, () => {
					beforeEach(async () => {
						await setStatus({ owner, systemStatus, section, suspend: true });
					});
					it('then calling withdraw() reverts', async () => {
						await assert.revert(
							ceth.withdraw(id, oneETH, { from: account1 }),
							'Operation prohibited'
						);
					});
					describe(`when ${section} is resumed`, () => {
						beforeEach(async () => {
							await setStatus({ owner, systemStatus, section, suspend: false });
						});
						it('then calling withdraw() succeeds', async () => {
							await ceth.withdraw(id, oneETH, { from: account1 });
						});
					});
				});
			});
		});

		describe('revert conditions', async () => {
			it('should revert if the withdraw would put them under minimum collateralisation', async () => {
				const nineETH = toUnit(9);
				await assert.revert(ceth.withdraw(id, nineETH, { from: account1 }), 'Cratio too low');
			});

			it('should revert if they try to withdraw all the collateral', async () => {
				await assert.revert(ceth.withdraw(id, tenETH, { from: account1 }), 'Cratio too low');
			});

			it('should revert if the sender is not borrower', async () => {
				await assert.revert(ceth.withdraw(id, tenETH, { from: account2 }));
			});
		});

		describe('should allow withdraws', async () => {
			beforeEach(async () => {
				await ceth.withdraw(id, oneETH, {
					from: account1,
				});
			});

			it('should decrease the total collateral of the loan', async () => {
				loan = await state.getLoan(account1, id);

				const expectedCollateral = tenETH.sub(oneETH);

				assert.bnEqual(loan.collateral, expectedCollateral);
			});

			it('should create a pending withdraw entry', async () => {
				const withdraw = await ceth.pendingWithdrawals(account1);

				assert.bnEqual(withdraw, oneETH);
			});

			it('should allow the withdrawer to withdraw', async () => {
				const bal = new BN(await getEthBalance(account1));

				await ceth.claim(oneETH, { from: account1 });

				const balAfter = new BN(await getEthBalance(account1));

				assert.bnGt(balAfter, bal);
			});
		});
	});

	describe('repayments', async () => {
		beforeEach(async () => {
			// make a loan here so we have a valid ID to pass to the blockers and reverts.
			tx = await ceth.open(oneHundredpUSD, pUSD, {
				value: tenETH,
				from: account1,
			});

			// to get past fee reclamation and settlement owing.
			await fastForwardAndUpdateRates(INTERACTION_DELAY);

			id = getid(tx);
		});

		describe('potential blocking conditions', async () => {
			['System', 'Issuance'].forEach(section => {
				describe(`when ${section} is suspended`, () => {
					beforeEach(async () => {
						await setStatus({ owner, systemStatus, section, suspend: true });
					});
					it('then calling repay() reverts', async () => {
						await assert.revert(
							ceth.repay(account1, id, onepUSD, { from: account1 }),
							'Operation prohibited'
						);
					});
					describe(`when ${section} is resumed`, () => {
						beforeEach(async () => {
							await setStatus({ owner, systemStatus, section, suspend: false });
						});
						it('then calling repay() succeeds', async () => {
							await ceth.repay(account1, id, onepUSD, { from: account1 });
						});
					});
				});
			});
		});

		describe('revert conditions', async () => {
			it('should revert if they try to repay 0', async () => {
				await assert.revert(
					ceth.repay(account1, id, 0, { from: account1 }),
					'Payment must be greater than 0'
				);
			});

			// account 2 had no pUSD
			it('should revert if they have no pUSD', async () => {
				await assert.revert(
					ceth.repay(account1, id, tenpUSD, { from: account2 }),
					'Not enough pynth balance'
				);
			});

			it('should revert if they try to pay more than the amount owing', async () => {
				await issuepUSDToAccount(toUnit(1000), account1);
				await assert.revert(
					ceth.repay(account1, id, toUnit(1000), { from: account1 }),
					'VM Exception while processing transaction: revert SafeMath: subtraction overflow'
				);
			});
		});

		describe('should allow repayments on an pUSD loan', async () => {
			// I'm not testing interest here, just that payment reduces the amounts.
			const expectedString = '90000';

			beforeEach(async () => {
				await issuepUSDToAccount(oneHundredpUSD, account2);
				tx = await ceth.repay(account1, id, tenpUSD, { from: account2 });
				loan = await state.getLoan(account1, id);
			});

			it('should work reduce the repayers balance', async () => {
				const expectedBalance = toUnit(90);
				assert.bnEqual(await pUSDPynth.balanceOf(account2), expectedBalance);
			});

			it('should update the loan', async () => {
				assert.equal(loan.amount.substring(0, 5), expectedString);
			});

			it('should emit the event properly', async () => {
				assert.eventEqual(tx, 'LoanRepaymentMade', {
					account: account1,
					repayer: account2,
					id: id,
					amountRepaid: tenpUSD,
					amountAfter: loan.amount,
				});
			});
		});

		describe('it should allow repayments on an pETH loan', async () => {
			// I don't want to test interest here. I just want to test repayment.
			const expectedString = '40000';

			beforeEach(async () => {
				tx = await ceth.open(fiveETH, pETH, {
					value: tenETH,
					from: account1,
				});

				await fastForwardAndUpdateRates(INTERACTION_DELAY);

				id = getid(tx);

				await issuepETHToAccount(twoETH, account2);

				tx = await ceth.repay(account1, id, oneETH, { from: account2 });

				loan = await state.getLoan(account1, id);
			});

			it('should work reduce the repayers balance', async () => {
				const expectedBalance = oneETH;

				assert.bnEqual(await pETHPynth.balanceOf(account2), expectedBalance);
			});

			it('should update the loan', async () => {
				assert.equal(loan.amount.substring(0, 5), expectedString);
			});

			it('should emit the event properly', async () => {
				assert.eventEqual(tx, 'LoanRepaymentMade', {
					account: account1,
					repayer: account2,
					id: id,
					amountRepaid: oneETH,
					amountAfter: loan.amount,
				});
			});
		});
	});

	describe('liquidations', async () => {
		let liquidatorEthBalBefore;

		beforeEach(async () => {
			// make a loan here so we have a valid ID to pass to the blockers and reverts.
			loan = await ceth.open(toUnit('200'), pUSD, {
				value: toUnit('2.6'),
				from: account1,
			});

			await fastForwardAndUpdateRates(INTERACTION_DELAY);

			id = getid(loan);
		});

		describe('potential blocking conditions', async () => {
			['System', 'Issuance'].forEach(section => {
				describe(`when ${section} is suspended`, () => {
					beforeEach(async () => {
						await setStatus({ owner, systemStatus, section, suspend: true });
					});
					it('then calling repay() reverts', async () => {
						await assert.revert(
							ceth.liquidate(account1, id, onepUSD, { from: account1 }),
							'Operation prohibited'
						);
					});
					describe(`when ${section} is resumed`, () => {
						beforeEach(async () => {
							await setStatus({ owner, systemStatus, section, suspend: false });
						});
						it('then calling liquidate() succeeds', async () => {
							// fast forward a long time to make sure the loan is underwater.
							await fastForwardAndUpdateRates(10 * YEAR);
							await ceth.liquidate(account1, id, oneETH, { from: account1 });
						});
					});
				});
			});
		});

		describe('revert conditions', async () => {
			it('should revert if they have no pUSD', async () => {
				await assert.revert(
					ceth.liquidate(account1, id, onepUSD, { from: account2 }),
					'Not enough pynth balance'
				);
			});

			it('should revert if they are not under collateralised', async () => {
				await issuepUSDToAccount(toUnit(100), account2);
				await ceth.deposit(account1, id, { value: oneETH, from: account1 });
				await fastForwardAndUpdateRates(INTERACTION_DELAY);

				await assert.revert(
					ceth.liquidate(account1, id, onepUSD, { from: account2 }),
					'Cratio above liquidation ratio'
				);
			});
		});

		describe('should allow liquidations on an undercollateralised pUSD loan', async () => {
			const liquidatedCollateral = new BN('1588888888888888880');
			let liquidationAmount;

			beforeEach(async () => {
				const timestamp = await currentTime();
				await exchangeRates.updateRates([pETH], ['90'].map(toUnit), timestamp, {
					from: oracle,
				});

				await issuepUSDToAccount(toUnit(1000), account2);

				loan = await state.getLoan(account1, id);

				liquidatorEthBalBefore = new BN(await getEthBalance(account2));

				liquidationAmount = await ceth.liquidationAmount(loan);

				tx = await ceth.liquidate(account1, id, liquidationAmount, {
					from: account2,
				});
			});

			it('should emit a liquidation event', async () => {
				assert.eventEqual(tx, 'LoanPartiallyLiquidated', {
					account: account1,
					id: id,
					liquidator: account2,
					amountLiquidated: liquidationAmount,
					collateralLiquidated: liquidatedCollateral,
				});
			});

			it('should reduce the liquidators pynth amount', async () => {
				const liquidatorBalance = await pUSDPynth.balanceOf(account2);
				const expectedBalance = toUnit('1000').sub(toUnit('130'));

				assert.bnClose(liquidatorBalance, expectedBalance, '100000000000');
			});

			it('should create a pending withdrawl entry', async () => {
				const withdaw = await ceth.pendingWithdrawals(account2);

				assert.bnEqual(withdaw, liquidatedCollateral);
			});

			it('should pay the interest to the fee pool', async () => {
				const balance = await pUSDPynth.balanceOf(FEE_ADDRESS);

				assert.bnGt(balance, toUnit(0));
			});

			it('should fix the collateralisation ratio of the loan', async () => {
				loan = await state.getLoan(account1, id);

				const ratio = await ceth.collateralRatio(loan);

				// the loan is very close 150%, we are in 10^18 land.
				assert.bnClose(ratio, toUnit('1.3'), '10000000000000');
			});

			it('should allow the liquidator to call claim', async () => {
				tx = await ceth.claim(liquidatedCollateral, { from: account2 });

				const bal = new BN(await getEthBalance(account2));

				assert.bnGt(bal, liquidatorEthBalBefore);
			});
		});

		describe('when a loan needs to be completely liquidated', async () => {
			let liquidatorEthBalBefore;

			beforeEach(async () => {
				const timestamp = await currentTime();
				await exchangeRates.updateRates([pETH], ['50'].map(toUnit), timestamp, {
					from: oracle,
				});

				loan = await state.getLoan(account1, id);

				await issuepUSDToAccount(toUnit(1000), account2);

				liquidatorEthBalBefore = new BN(await getEthBalance(account2));

				tx = await ceth.liquidate(account1, id, toUnit(1000), {
					from: account2,
				});
			});

			it('should emit the event', async () => {
				assert.eventEqual(tx, 'LoanClosedByLiquidation', {
					account: account1,
					id: id,
					liquidator: account2,
					amountLiquidated: loan.amount,
					collateralLiquidated: toUnit('2.6'),
				});
			});

			it('should close the loan correctly', async () => {
				loan = await state.getLoan(account1, id);

				assert.equal(loan.amount, 0);
				assert.equal(loan.collateral, 0);
				assert.equal(loan.interestIndex, 0);
			});

			it('should reduce the liquidators pynth amount', async () => {
				const liquidatorBalance = await pUSDPynth.balanceOf(account2);
				const expectedBalance = toUnit(1000).sub(toUnit('200'));

				assert.bnClose(liquidatorBalance, expectedBalance, '1000000000000000');
			});

			it('should create a pending withdrawl entry', async () => {
				const withdaw = await ceth.pendingWithdrawals(account2);

				assert.bnEqual(withdaw, toUnit('2.6'));
			});

			it('should reduce the liquidators pynth balance', async () => {
				tx = await ceth.claim(twoETH, { from: account2 });

				const bal = new BN(await getEthBalance(account2));

				assert.bnGt(bal, liquidatorEthBalBefore);
			});
		});
	});

	describe('closing', async () => {
		beforeEach(async () => {
			// make a loan here so we have a valid ID to pass to the blockers and reverts.
			loan = await ceth.open(oneHundredpUSD, pUSD, {
				value: twoETH,
				from: account1,
			});
			id = getid(loan);

			await fastForwardAndUpdateRates(INTERACTION_DELAY);
		});

		describe('potential blocking conditions', async () => {
			['System', 'Issuance'].forEach(section => {
				describe(`when ${section} is suspended`, () => {
					beforeEach(async () => {
						await setStatus({ owner, systemStatus, section, suspend: true });
					});
					it('then calling close() reverts', async () => {
						await assert.revert(ceth.close(id, { from: account1 }), 'Operation prohibited');
					});
					describe(`when ${section} is resumed`, () => {
						beforeEach(async () => {
							await setStatus({ owner, systemStatus, section, suspend: false });
						});
						it('then calling close() succeeds', async () => {
							// Give them some more pUSD to make up for the fees.
							await issuepUSDToAccount(tenpUSD, account1);
							await ceth.close(id, { from: account1 });
						});
					});
				});
			});
		});

		describe('revert conditions', async () => {
			it('should revert if they have no pUSD', async () => {
				await assert.revert(ceth.close(id, { from: account1 }), 'Not enough pynth balance');
			});

			it('should revert if they are not the borrower', async () => {
				await assert.revert(ceth.close(id, { from: account2 }), 'Loan does not exist');
			});
		});

		describe('when it works', async () => {
			beforeEach(async () => {
				// Give them some more pUSD to make up for the fees.
				await issuepUSDToAccount(tenpUSD, account1);

				tx = await ceth.close(id, { from: account1 });
			});

			it('should record the loan as closed', async () => {
				loan = await state.getLoan(account1, id);

				assert.equal(loan.amount, 0);
				assert.equal(loan.collateral, 0);
				assert.equal(loan.accruedInterest, 0);
				assert.equal(loan.interestIndex, 0);
			});

			it('should pay the fee pool', async () => {
				const balance = await pUSDPynth.balanceOf(FEE_ADDRESS);

				assert.bnGt(balance, toUnit(0));
			});

			it('should add a pending withdrawl entry', async () => {
				assert.bnEqual(await ceth.pendingWithdrawals(account1), twoETH);
			});

			it('should allow the closer to withdraw', async () => {
				const bal = new BN(await getEthBalance(account1));

				await ceth.claim(oneETH, { from: account1 });

				const balAfter = new BN(await getEthBalance(account1));

				assert.bnGt(balAfter, bal);
			});

			it('should emit the event', async () => {
				assert.eventEqual(tx, 'LoanClosed', {
					account: account1,
					id: id,
				});
			});
		});
	});

	describe('drawing', async () => {
		beforeEach(async () => {
			// make a loan here so we have a valid ID to pass to the blockers and reverts.
			tx = await ceth.open(oneHundredpUSD, pUSD, {
				value: twoETH,
				from: account1,
			});

			id = getid(tx);

			await fastForwardAndUpdateRates(INTERACTION_DELAY);
		});

		describe('potential blocking conditions', async () => {
			['System', 'Issuance'].forEach(section => {
				describe(`when ${section} is suspended`, () => {
					beforeEach(async () => {
						await setStatus({ owner, systemStatus, section, suspend: true });
					});
					it('then calling draw() reverts', async () => {
						await assert.revert(ceth.draw(id, onepUSD, { from: account1 }), 'Operation prohibited');
					});
					describe(`when ${section} is resumed`, () => {
						beforeEach(async () => {
							await setStatus({ owner, systemStatus, section, suspend: false });
						});
						it('then calling draw() succeeds', async () => {
							await ceth.draw(id, onepUSD, {
								from: account1,
							});
						});
					});
				});
			});
			describe('when rates have gone stale', () => {
				beforeEach(async () => {
					await fastForward((await exchangeRates.rateStalePeriod()).add(web3.utils.toBN('300')));
				});
				it('then calling draw() reverts', async () => {
					await assert.revert(
						ceth.draw(id, onepUSD, { from: account1 }),
						'Collateral rate is invalid'
					);
				});
				describe('when ETH gets a rate', () => {
					beforeEach(async () => {
						await updateRatesWithDefaults();
					});
					it('then calling draw() succeeds', async () => {
						await ceth.draw(id, onepUSD, { from: account1 });
					});
				});
			});
		});

		describe('revert conditions', async () => {
			it('should revert if the draw would under collateralise the loan', async () => {
				await assert.revert(
					ceth.draw(id, oneHundredpUSD, { from: account1 }),
					'Cannot draw this much'
				);
			});
		});

		describe('should draw the loan down', async () => {
			beforeEach(async () => {
				tx = await ceth.draw(id, toUnit(30), { from: account1 });

				loan = await state.getLoan(account1, id);
			});

			it('should update the amount on the loan', async () => {
				assert.equal(loan.amount, toUnit(130).toString());
			});
		});
	});

	describe('Accrue Interest', async () => {
		beforeEach(async () => {
			// 0.005% / 31556926 (seconds in common year)
			await manager.setBaseBorrowRate(158443823, { from: owner });
		});

		it('should correctly determine the interest on loans', async () => {
			tx = await ceth.open(oneHundredpUSD, pUSD, {
				value: twoETH,
				from: account1,
			});

			id = getid(tx);

			// after a year we should have accrued about 0.005% + (100/2100) = 0.05261904762

			await fastForwardAndUpdateRates(YEAR);

			// deposit some eth to trigger the interest accrual.

			tx = await ceth.deposit(account1, id, { from: account1, value: oneETH });

			loan = await state.getLoan(account1, id);

			let interest = Math.round(parseFloat(fromUnit(loan.accruedInterest)) * 10000) / 10000;

			assert.equal(interest, 5.2619);

			tx = await ceth.open(oneHundredpUSD, pUSD, {
				value: twoETH,
				from: account1,
			});

			const id2 = getid(tx);

			// after a year we should have accrued about 0.005% + (200/2200) = 0.09590909091

			await fastForwardAndUpdateRates(YEAR);

			tx = await ceth.deposit(account1, id2, { from: account1, value: oneETH });

			loan = await state.getLoan(account1, id2);

			interest = Math.round(parseFloat(fromUnit(loan.accruedInterest)) * 10000) / 10000;

			assert.equal(interest, 9.5909);

			// after two years we should have accrued (this math is rough)
			// 0.005% + (100/2100) = 0.05261904762 +
			// 0.005% + (200/2200) = 0.09590909091 +
			//                     = 0.1485281385

			tx = await ceth.deposit(account1, id, { from: account1, value: oneETH });

			loan = await state.getLoan(account1, id);

			interest = Math.round(parseFloat(fromUnit(loan.accruedInterest)) * 10000) / 10000;

			assert.equal(interest, 14.8528);
		});
	});
});
