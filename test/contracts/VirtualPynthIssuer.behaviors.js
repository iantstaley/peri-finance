'use strict';

const { artifacts, web3 } = require('hardhat');
const { smockit } = require('@eth-optimism/smock');
const { toBytes32 } = require('../..');
const { prepareSmocks } = require('./helpers');

let VirtualPynthIssuer, PeriFinance;

module.exports = function({ accounts }) {
	before(async () => {
		// VirtualPynthIssuer = artifacts.require('VirtualPynthIssuer');
		PeriFinance = artifacts.require('PeriFinance');
	});

	beforeEach(async () => {
		({ mocks: this.mocks, resolver: this.resolver } = await prepareSmocks({
			contracts: [
				'DebtCache',
				'DelegateApprovals',
				'ExchangeRates',
				'ExchangeState',
				'FeePool',
				'FlexibleStorage',
				'Issuer',
				// 'PeriFinance',
				'VirtualPynthIssuer',
				'SystemStatus',
				'TradingRewards',
			],
			accounts: accounts.slice(10), // mock using accounts after the first few
		}));
	});

	before(async () => {
		VirtualPynthIssuer.link(await artifacts.require('SafeDecimalMath').new());
	});

	return {
		whenInstantiated: ({ owner }, cb) => {
			describe(`when instantiated`, () => {
				beforeEach(async () => {
					this.instance = await PeriFinance.new(owner, this.resolver.address);
					await this.instance.rebuildCache();
				});
				cb();
			});
		},
		whenMockedToAllowChecks: cb => {
			describe(`when mocked to allow invocation checks`, () => {
				beforeEach(async () => {
					this.mocks.Issuer.smocked.pynthsByAddress.will.return.with(toBytes32());
				});
				cb();
			});
		},
		whenMockedWithExchangeRatesValidity: ({ valid = true }, cb) => {
			describe(`when mocked with valid exchange rates`, () => {
				beforeEach(async () => {
					this.mocks.ExchangeRates.smocked.anyRateIsInvalid.will.return.with(!valid);
				});
				cb();
			});
		},
		whenMockedWithNoPriorExchangesToSettle: cb => {
			describe(`when mocked with no prior exchanges to settle`, () => {
				beforeEach(async () => {
					this.mocks.ExchangeState.smocked.getMaxTimestamp.will.return.with('0');
					this.mocks.ExchangeState.smocked.getLengthOfEntries.will.return.with('0');
				});
				cb();
			});
		},
		whenMockedWithUintSystemSetting: ({ setting, value }, cb) => {
			describe(`when SystemSetting.${setting} is mocked to ${value}`, () => {
				beforeEach(async () => {
					this.mocks.FlexibleStorage.smocked.getUIntValue.will.return.with((contract, record) =>
						contract === toBytes32('SystemSettings') && record === toBytes32(setting) ? value : '0'
					);
				});
				cb();
			});
		},
		whenMockedEffectiveRateAsEqual: cb => {
			describe(`when mocked with exchange rates giving an effective value of 1:1`, () => {
				beforeEach(async () => {
					this.mocks.ExchangeRates.smocked.effectiveValueAndRates.will.return.with(
						(srcKey, amount, destKey) => [amount, (1e18).toString(), (1e18).toString()]
					);
				});
				cb();
			});
		},
		whenMockedLastNRates: cb => {
			describe(`when mocked 1e18 as last n rates`, () => {
				beforeEach(async () => {
					this.mocks.ExchangeRates.smocked.ratesAndUpdatedTimeForCurrencyLastNRounds.will.return.with(
						[[], []]
					);
				});
				cb();
			});
		},
		whenMockedAPynthToIssueAmdBurn: cb => {
			describe(`when mocked a pynth to burn`, () => {
				beforeEach(async () => {
					// create and share the one pynth for all Issuer.pynths() calls
					this.mocks.pynth = await smockit(artifacts.require('Pynth').abi);
					this.mocks.pynth.smocked.burn.will.return();
					this.mocks.pynth.smocked.issue.will.return();
					this.mocks.pynth.smocked.proxy.will.return.with(web3.eth.accounts.create().address);
					this.mocks.Issuer.smocked.pynths.will.return.with(currencyKey => {
						// but when currency
						this.mocks.pynth.smocked.currencyKey.will.return.with(currencyKey);
						return this.mocks.pynth.address;
					});
				});
				cb();
			});
		},
		whenMockedExchangeStatePersistance: cb => {
			describe(`when mocking exchange state persistance`, () => {
				beforeEach(async () => {
					this.mocks.ExchangeRates.smocked.getCurrentRoundId.will.return.with('0');
					this.mocks.ExchangeState.smocked.appendExchangeEntry.will.return();
				});
				cb();
			});
		},
	};
};
