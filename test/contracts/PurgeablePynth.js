'use strict';

const { artifacts, contract, web3 } = require('hardhat');

const { assert, addSnapshotBeforeRestoreAfterEach } = require('./common');

const TokenState = artifacts.require('TokenState');
const Proxy = artifacts.require('Proxy');
const PurgeablePynth = artifacts.require('PurgeablePynth');

const { currentTime, fastForward, toUnit } = require('../utils')();
const {
	toBytes32,
	constants: { ZERO_ADDRESS },
} = require('../..');

const {
	setExchangeFeeRateForPynths,
	issuePynthsToUser,
	onlyGivenAddressCanInvoke,
	ensureOnlyExpectedMutativeFunctions,
	setStatus,
} = require('./helpers');

const { setupAllContracts } = require('./setup');

contract('PurgeablePynth', accounts => {
	const [pUSD, PERI, pAUD, iETH] = ['pUSD', 'PERI', 'pAUD', 'iETH'].map(toBytes32);
	const pynthKeys = [pUSD, pAUD, iETH];
	const [deployerAccount, owner, oracle, , account1, account2] = accounts;

	let exchangeRates,
		exchanger,
		systemSettings,
		pUSDContract,
		pAUDContract,
		iETHContract,
		systemStatus,
		timestamp,
		addressResolver,
		debtCache,
		issuer;

	before(async () => {
		PurgeablePynth.link(await artifacts.require('SafeDecimalMath').new());

		({
			AddressResolver: addressResolver,
			ExchangeRates: exchangeRates,
			Exchanger: exchanger,
			PynthpUSD: pUSDContract,
			PynthpAUD: pAUDContract,
			SystemStatus: systemStatus,
			SystemSettings: systemSettings,
			DebtCache: debtCache,
			Issuer: issuer,
		} = await setupAllContracts({
			accounts,
			pynths: ['pUSD', 'pAUD'],
			contracts: [
				'ExchangeRates',
				'Exchanger',
				'DebtCache',
				'Issuer',
				'FeePool',
				'FeePoolEternalStorage',
				'PeriFinance',
				'SystemStatus',
				'SystemSettings',
				'CollateralManager',
				'StakingStateUSDC',
			],
		}));

		timestamp = await currentTime();
	});

	beforeEach(async () => {
		// set a 0.3% exchange fee rate
		const exchangeFeeRate = toUnit('0.003');
		await setExchangeFeeRateForPynths({
			owner,
			systemSettings,
			pynthKeys,
			exchangeFeeRates: pynthKeys.map(() => exchangeFeeRate),
		});
	});

	addSnapshotBeforeRestoreAfterEach();

	const deployPynth = async ({ currencyKey, proxy, tokenState }) => {
		tokenState =
			tokenState ||
			(await TokenState.new(owner, ZERO_ADDRESS, {
				from: deployerAccount,
			}));

		proxy = proxy || (await Proxy.new(owner, { from: deployerAccount }));

		const pynth = await PurgeablePynth.new(
			proxy.address,
			tokenState.address,
			`Pynth ${currencyKey}`,
			currencyKey,
			owner,
			toBytes32(currencyKey),
			web3.utils.toWei('0'),
			addressResolver.address,
			{
				from: deployerAccount,
			}
		);
		return { pynth, tokenState, proxy };
	};

	describe('when a Purgeable pynth is added and connected to PeriFinance', () => {
		beforeEach(async () => {
			// Create iETH as a PurgeablePynth as we do not create any PurgeablePynth
			// in the migration script
			const { pynth, tokenState, proxy } = await deployPynth({
				currencyKey: 'iETH',
			});
			const pynths = [pynth.address];
			await tokenState.setAssociatedContract(pynth.address, { from: owner });
			await proxy.setTarget(pynth.address, { from: owner });
			await issuer.addPynths(pynths, { from: owner });

			iETHContract = pynth;
		});

		it('ensure only known functions are mutative', () => {
			ensureOnlyExpectedMutativeFunctions({
				abi: iETHContract.abi,
				ignoreParents: ['Pynth'],
				expected: ['purge'],
			});
		});

		it('ensure the list of resolver addresses are as expected', async () => {
			const actual = await iETHContract.resolverAddressesRequired();
			assert.deepEqual(
				actual,
				['SystemStatus', 'Exchanger', 'Issuer', 'FeePool', 'ExchangeRates'].map(toBytes32)
			);
		});

		it('disallow purge calls by everyone bar the owner', async () => {
			await onlyGivenAddressCanInvoke({
				accounts,
				fnc: iETHContract.purge,
				args: [[]],
				skipPassCheck: true,
				address: owner,
				reason: 'Owner only function',
			});
		});

		describe("when there's a price for the purgeable pynth", () => {
			beforeEach(async () => {
				await exchangeRates.updateRates(
					[pAUD, PERI, iETH],
					['0.5', '1', '170'].map(toUnit),
					timestamp,
					{
						from: oracle,
					}
				);
				await debtCache.takeDebtSnapshot();
			});

			describe('and a user holds 100K USD worth of purgeable pynth iETH', () => {
				let amountToExchange;
				let userpUSDBalance;
				let balanceBeforePurge;
				beforeEach(async () => {
					// issue the user 100K USD worth of iETH
					amountToExchange = toUnit(1e5);
					const iETHAmount = await exchangeRates.effectiveValue(pUSD, amountToExchange, iETH);
					await issuePynthsToUser({
						owner,
						issuer,
						addressResolver,
						pynthContract: iETHContract,
						user: account1,
						amount: iETHAmount,
					});
					userpUSDBalance = await pUSDContract.balanceOf(account1);
					balanceBeforePurge = await iETHContract.balanceOf(account1);
				});

				describe('when the system is suspended', () => {
					beforeEach(async () => {
						await setStatus({ owner, systemStatus, section: 'System', suspend: true });
					});
					it('then purge() still works as expected', async () => {
						await iETHContract.purge([account1], { from: owner });
						assert.equal(await iETHContract.balanceOf(account1), '0');
					});
				});
				describe('when the pynth is stale', () => {
					beforeEach(async () => {
						await fastForward((await exchangeRates.rateStalePeriod()).add(web3.utils.toBN('300')));
					});
					it('then purge() reverts', async () => {
						await assert.revert(
							iETHContract.purge([account1], { from: owner }),
							'Src/dest rate invalid or not found'
						);
					});
					describe('when rates are received', () => {
						beforeEach(async () => {
							await exchangeRates.updateRates([iETH], ['170'].map(toUnit), await currentTime(), {
								from: oracle,
							});
							await debtCache.takeDebtSnapshot();
						});
						it('then purge() still works as expected', async () => {
							await iETHContract.purge([account1], { from: owner });
							assert.equal(await iETHContract.balanceOf(account1), '0');
						});
					});
				});
				describe('when purge is called for the pynth', () => {
					let txn;
					beforeEach(async () => {
						txn = await iETHContract.purge([account1], { from: owner });
					});
					it('then the user is at 0 balance', async () => {
						const userBalance = await iETHContract.balanceOf(account1);
						assert.bnEqual(
							userBalance,
							toUnit(0),
							'The user must no longer have a balance after the purge'
						);
					});
					it('and they have the value added back to pUSD (with fees taken out)', async () => {
						const userBalance = await pUSDContract.balanceOf(account1);

						const {
							amountReceived,
							// exchangeFee,
							// exchangeFeeRate,
						} = await exchanger.getAmountsForExchange(balanceBeforePurge, iETH, pUSD);

						assert.bnEqual(
							userBalance,
							amountReceived.add(userpUSDBalance),
							'User must be credited back in pUSD from the purge'
						);
					});
					it('then the pynth has totalSupply back at 0', async () => {
						const iETHTotalSupply = await iETHContract.totalSupply();
						assert.bnEqual(iETHTotalSupply, toUnit(0), 'Total supply must be 0 after the purge');
					});

					it('must issue the Purged event', () => {
						const purgedEvent = txn.logs.find(log => log.event === 'Purged');

						assert.eventEqual(purgedEvent, 'Purged', {
							account: account1,
							value: balanceBeforePurge,
						});
					});
				});

				describe('when purge is invoked with no accounts', () => {
					let txn;
					let totalSupplyBeforePurge;
					beforeEach(async () => {
						totalSupplyBeforePurge = await iETHContract.totalSupply();
						txn = await iETHContract.purge([], { from: owner });
					});
					it('then no change occurs', async () => {
						const userBalance = await iETHContract.balanceOf(account1);
						assert.bnEqual(
							userBalance,
							balanceBeforePurge,
							'The user must not be impacted by an empty purge'
						);
					});
					it('and the totalSupply must be unchanged', async () => {
						const iETHTotalSupply = await iETHContract.totalSupply();
						assert.bnEqual(
							iETHTotalSupply,
							totalSupplyBeforePurge,
							'Total supply must be unchanged'
						);
					});
					it('and no events are emitted', async () => {
						assert.equal(txn.logs.length, 0, 'No purged event must be emitted');
					});
				});

				describe('when the user holds 5000 USD worth of the purgeable pynth iETH', () => {
					let balanceBeforePurgeUser2;
					beforeEach(async () => {
						// Note: 5000 is chosen to be large enough to accommodate exchange fees which
						// ultimately limit the total supply of that pynth
						const amountToExchange = toUnit(5000);
						const iETHAmount = await exchangeRates.effectiveValue(pUSD, amountToExchange, iETH);
						await issuePynthsToUser({
							owner,
							issuer,
							addressResolver,
							pynthContract: iETHContract,
							user: account2,
							amount: iETHAmount,
						});
						balanceBeforePurgeUser2 = await iETHContract.balanceOf(account2);
					});
					describe('when purge is invoked with both accounts', () => {
						it('then it reverts as the totalSupply exceeds the 100,000USD max', async () => {
							await assert.revert(iETHContract.purge([account1, account2], { from: owner }));
						});
					});
					describe('when purge is invoked with just one account', () => {
						it('then it reverts as the totalSupply exceeds the 100,000USD max', async () => {
							await assert.revert(iETHContract.purge([account2], { from: owner }));
						});
					});
					describe('when the exchange rates has the pynth as frozen', () => {
						beforeEach(async () => {
							// prevent circuit breaker from firing by upping the threshold to a factor 4
							// because the price moved from 170 (before inverse pricing) to 50 (frozen at lower limit)
							await systemSettings.setPriceDeviationThresholdFactor(toUnit('5'), { from: owner });

							await exchangeRates.setInversePricing(
								iETH,
								toUnit(100),
								toUnit(150),
								toUnit(50),
								false,
								false,
								{ from: owner }
							);
							await exchangeRates.updateRates([iETH], ['160'].map(toUnit), timestamp, {
								from: oracle,
							});
							await debtCache.takeDebtSnapshot();
						});
						describe('when purge is invoked with just one account', () => {
							let txn;

							beforeEach(async () => {
								txn = await iETHContract.purge([account2], { from: owner });
							});

							it('then it must issue the Purged event', () => {
								const purgedEvent = txn.logs.find(log => log.event === 'Purged');

								assert.eventEqual(purgedEvent, 'Purged', {
									account: account2,
									value: balanceBeforePurgeUser2,
								});
							});

							it('and the second user is at 0 balance', async () => {
								const userBalance = await iETHContract.balanceOf(account2);
								assert.bnEqual(
									userBalance,
									toUnit(0),
									'The second user must no longer have a balance after the purge'
								);
							});

							it('and no change occurs for the other user', async () => {
								const userBalance = await iETHContract.balanceOf(account1);
								assert.bnEqual(
									userBalance,
									balanceBeforePurge,
									'The first user must not be impacted by a purge for another user'
								);
							});
						});

						describe('when purge is invoked with both accounts', () => {
							let txn;
							beforeEach(async () => {
								txn = await iETHContract.purge([account2, account1], { from: owner });
							});
							it('then it must issue two purged events', () => {
								const events = txn.logs.filter(log => log.event === 'Purged');

								assert.eventEqual(events[0], 'Purged', {
									account: account2,
									value: balanceBeforePurgeUser2,
								});
								assert.eventEqual(events[1], 'Purged', {
									account: account1,
									value: balanceBeforePurge,
								});
							});
							it('and the total supply of the pynth must be 0', async () => {
								const totalSupply = await iETHContract.totalSupply();
								assert.bnEqual(totalSupply, toUnit('0'), 'Total supply must be 0 after full purge');
							});
						});
					});
				});
			});
		});
	});

	describe('Replacing an existing Pynth with a Purgeable one to purge and remove it', () => {
		describe('when pAUD has a price', () => {
			beforeEach(async () => {
				await exchangeRates.updateRates([pAUD], ['0.776845993'].map(toUnit), timestamp, {
					from: oracle,
				});
				await debtCache.takeDebtSnapshot();
			});
			describe('when a user holds some pAUD', () => {
				let userBalanceOfOldPynth;
				let userpUSDBalance;
				beforeEach(async () => {
					const amountToExchange = toUnit('100');

					// as pAUD is MockPynth, we can invoke this directly
					await pAUDContract.issue(account1, amountToExchange);

					userpUSDBalance = await pUSDContract.balanceOf(account1);
					this.oldPynth = pAUDContract;
					userBalanceOfOldPynth = await this.oldPynth.balanceOf(account1);
					assert.equal(
						userBalanceOfOldPynth.gt(toUnit('0')),
						true,
						'The pAUD balance is greater than zero after exchange'
					);
				});

				describe('when the pAUD pynth has its totalSupply set to 0 by the owner', () => {
					beforeEach(async () => {
						this.totalSupply = await this.oldPynth.totalSupply();
						this.oldTokenState = await TokenState.at(await this.oldPynth.tokenState());
						this.oldProxy = await Proxy.at(await this.oldPynth.proxy());
						await this.oldPynth.setTotalSupply(toUnit('0'), { from: owner });
					});
					describe('and the old pAUD pynth is removed from PeriFinance', () => {
						beforeEach(async () => {
							await issuer.removePynth(pAUD, { from: owner });
						});
						describe('when a Purgeable pynth is added to replace the existing pAUD', () => {
							beforeEach(async () => {
								const { pynth } = await deployPynth({
									currencyKey: 'pAUD',
									proxy: this.oldProxy,
									tokenState: this.oldTokenState,
								});
								this.replacement = pynth;
							});
							describe('and it is added to PeriFinance', () => {
								beforeEach(async () => {
									await issuer.addPynths([this.replacement.address], { from: owner });
									await this.replacement.rebuildCache();
								});

								describe('and the old pAUD TokenState and Proxy is connected to the replacement pynth', () => {
									beforeEach(async () => {
										await this.oldTokenState.setAssociatedContract(this.replacement.address, {
											from: owner,
										});
										await this.oldProxy.setTarget(this.replacement.address, { from: owner });
										// now reconnect total supply
										await this.replacement.setTotalSupply(this.totalSupply, { from: owner });
									});
									it('then the user balance has transferred', async () => {
										const balance = await this.replacement.balanceOf(account1);
										assert.bnEqual(
											balance,
											userBalanceOfOldPynth,
											'The balance after connecting TokenState must not have changed'
										);
									});
									describe('when owner attemps to remove new pynth from the system', () => {
										it('then it reverts', async () => {
											await assert.revert(issuer.removePynth(pAUD, { from: owner }));
										});
									});
									describe('and purge is called on the replacement pAUD contract', () => {
										let txn;

										beforeEach(async () => {
											txn = await this.replacement.purge([account1], { from: owner });
										});
										it('then the user now has a 0 balance in the replacement', async () => {
											const balance = await this.replacement.balanceOf(account1);
											assert.bnEqual(balance, toUnit('0'), 'The balance after purge must be 0');
										});
										it('and their balance must have gone back into pUSD', async () => {
											const balance = await pUSDContract.balanceOf(account1);

											const { amountReceived } = await exchanger.getAmountsForExchange(
												userBalanceOfOldPynth,
												pAUD,
												pUSD
											);

											assert.bnEqual(
												balance,
												amountReceived.add(userpUSDBalance),
												'The pUSD balance after purge must return to the initial amount, less fees'
											);
										});
										it('and the purge event is issued', async () => {
											const purgedEvent = txn.logs.find(log => log.event === 'Purged');

											assert.eventEqual(purgedEvent, 'Purged', {
												account: account1,
												value: userBalanceOfOldPynth,
											});
										});
										describe('when the purged pynth is removed from the system', () => {
											beforeEach(async () => {
												await issuer.removePynth(pAUD, { from: owner });
											});
											it('then the balance remains in USD (and no errors occur)', async () => {
												const balance = await pUSDContract.balanceOf(account1);

												const { amountReceived } = await exchanger.getAmountsForExchange(
													userBalanceOfOldPynth,
													pAUD,
													pUSD
												);

												assert.bnEqual(
													balance,
													amountReceived.add(userpUSDBalance),
													'The pUSD balance after purge must return to the initial amount, less fees'
												);
											});
										});
									});
								});
							});
						});
					});
				});
			});
		});
	});
});
