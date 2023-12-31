import * as hre from 'hardhat';

import { Command } from 'commander';
import { Wallet } from 'zksync-web3';
import { Deployer } from '@matterlabs/hardhat-zksync-deploy';

import * as path from 'path';
import * as fs from 'fs';

import { Language, SYSTEM_CONTRACTS, YulContractDescrption } from './constants';
import { BytesLike, formatUnits, parseUnits } from 'ethers/lib/utils';
import { BigNumber, BigNumberish, ethers } from 'ethers';
import { hashBytecode } from 'zksync-web3/build/src/utils';

const testConfigPath = path.join(process.env.ZKSYNC_HOME as string, `etc/test_config/constant`);
const ethTestConfig = JSON.parse(fs.readFileSync(`${testConfigPath}/eth.json`, { encoding: 'utf-8' }));

// Script that publishes preimages for all the system contracts on zkSync
// and outputs the JSON that can be used for performing the necessary upgrade
const DEFAULT_L2_TX_GAS_LIMIT = 2097152;

async function getMarkers(dependencies: BytesLike[], deployer: Deployer): Promise<[string, BigNumber][]> {
    const contract = new ethers.Contract(
        SYSTEM_CONTRACTS.knownCodesStorage.address,
        (await deployer.loadArtifact('KnownCodesStorage')).abi,
        deployer.zkWallet
    );

    const promises = dependencies.map(async (dep) => {
        const hash = ethers.utils.hexlify(hashBytecode(dep));
        const marker = BigNumber.from(await contract.getMarker(hash));

        return [hash, marker] as [string, BigNumber];
    });

    return await Promise.all(promises);
}

// Checks whether the marker has been set correctly in the KnownCodesStorage
// system contract
async function checkMarker(dependencies: string[], deployer: Deployer) {
    const markers = await getMarkers(dependencies, deployer);

    for(const [bytecodeHash, marker] of markers) {
        if(marker.eq(0)) {
            throw new Error(`Failed to mark ${bytecodeHash}`);
        }
    }
}

function totalBytesLength(dependencies: string[]): number {
    return dependencies.reduce((prev, curr) => prev + ethers.utils.arrayify(curr).length, 0);
}

async function publishFactoryDeps(
    dependenciesNames: string[], 
    dependencies: string[],
    deployer: Deployer,
    nonce: number,
    gasPrice: BigNumber
) {
    if(dependencies.length == 0) {
        return;
    }
    
    const combinedLength = totalBytesLength(dependencies);

    console.log(`\nPublishing dependencies for contracts ${dependenciesNames.join(', ')}`);
    console.log(`Combined length ${combinedLength}`);

    const txHandle = await deployer.zkWallet.requestExecute({
        contractAddress: ethers.constants.AddressZero,
        calldata: '0x',
        l2GasLimit: DEFAULT_L2_TX_GAS_LIMIT,
        factoryDeps: dependencies,
        overrides: {
            nonce,
            gasPrice,
            gasLimit: 3000000
        }
    })
    console.log(`Transaction hash: ${txHandle.hash}`);

    // Waiting for the transaction to be processed by the server
    await txHandle.wait();

    console.log('Transaction complete! Checking markers on L2...');

    // Double checking that indeed the dependencies have been marked as known
    await checkMarker(dependencies, deployer);
}

export interface ForceDeployment {
    // The bytecode hash to put on an address
    bytecodeHash: BytesLike;
    // The address on which to deploy the bytecodehash to
    newAddress: string;
    // The value with which to initialize a contract
    value: BigNumberish;
    // The constructor calldata
    input: BytesLike;
    // Whether to call the constructor
    callConstructor: boolean;
}

async function outputDeploymentParams(deployer: Deployer) {
    const upgradeParamsPromises: Promise<ForceDeployment>[] = Object.values(SYSTEM_CONTRACTS).map(async (systemContractInfo) => {
        let bytecode: string;

        if (systemContractInfo.lang === Language.Yul) {
            bytecode = readYulBytecode(systemContractInfo);
        } else {
            bytecode = (await deployer.loadArtifact(systemContractInfo.codeName)).bytecode;
        }
        const bytecodeHash = hashBytecode(bytecode);
        
        return {
            bytecodeHash: ethers.utils.hexlify(bytecodeHash),
            newAddress: systemContractInfo.address,
            value: "0",
            input: '0x',
            callConstructor: false
        }
    });
    const upgradeParams = await Promise.all(upgradeParamsPromises);

    console.log(JSON.stringify(upgradeParams, null, 2));
}

// Returns an array of bytecodes that should be published along with 
async function displayFactoryDeps(
    contractName: string,
    factoryDeps: string[],
    deployer: Deployer
): Promise<[string[], number]> {
    console.log(`\nFactory dependencies for contract ${contractName}:`);
    let currentLength = 0;  

    let bytecodesToDeploy: string[] = [];

    const hashesAndMarkers = await getMarkers(factoryDeps, deployer);

    for(let i = 0; i < factoryDeps.length; i++) {
        const depLength = ethers.utils.arrayify(factoryDeps[i]).length;
        const [hash, marker] = hashesAndMarkers[i];
        console.log(`${hash} (length: ${depLength} bytes) (deployed: ${marker})`);

        if(marker.eq(0)) {
            currentLength += depLength;
            bytecodesToDeploy.push(factoryDeps[i]);
        }
    }

    console.log(`Combined length to deploy: ${currentLength}`);

    return [bytecodesToDeploy, currentLength];
}

async function publishBootloader(
    deployer: Deployer,
    nonce: number,
    gasPrice: BigNumber
) {
    console.log('\nPublishing bootloader bytecode:');
    const bootloaderCode = ethers.utils.hexlify(fs.readFileSync('./bootloader/build/artifacts/proved_block.yul/proved_block.yul.zbin'));

    const [deps, ] = await displayFactoryDeps('Bootloader', [bootloaderCode], deployer);

    await publishFactoryDeps(
        ['Bootloader'],
        deps,
        deployer,
        nonce,
        gasPrice
    );
}

            
// Maximum length of the combined length of dependencies
const MAX_COMBINED_LENGTH = 90000;


/// Publishes the contract with the given name, along with its dependencies. 
/// It modifies currentToPublishNames and currentToPublish, in place.
/// Returns the new nonce.
async function publishContract(
    contractName: string,
    factoryDeps: string[],
    currentToPublishNames: string[],
    currentToPublish: string[],
    currentNonce: number,
    gasPrice: BigNumber,
    deployer: Deployer
): Promise<number> {
    let [bytecodesToDeploy, currentLength] = await displayFactoryDeps(contractName, factoryDeps, deployer);

    if(currentLength > MAX_COMBINED_LENGTH) {
        throw new Error(`Can not publish dependencies of contract ${contractName}`);
    }

    const currentCombinedLength = currentToPublish.reduce((prev, dep) => prev + ethers.utils.arrayify(dep).length, 0);

    if(currentLength + currentCombinedLength > MAX_COMBINED_LENGTH) {
        await publishFactoryDeps(
            currentToPublishNames,
            currentToPublish,
            deployer,
            currentNonce,
            gasPrice
        );

        currentToPublishNames.splice(0);
        currentToPublish.splice(0);

        currentNonce += 1;
    }

    currentToPublishNames.push(contractName);
    currentToPublish.push(
        ...bytecodesToDeploy
    );

    return currentNonce;
}

function readYulBytecode(description: YulContractDescrption) {
    const contractName = description.codeName;
    const path = `contracts/${description.path}/artifacts/${contractName}.yul/${contractName}.yul.zbin`;
    const dependency = ethers.utils.hexlify(fs.readFileSync(path));

    return dependency;
}

async function main() {
    const program = new Command();

    program.version('0.1.0').name('publish preimages').description('publish preimages for the L2 contracts');

    program
        .option('--private-key <private-key>')
        .option('--gas-price <gas-price>')
        .option('--nonce <nonce>')
        .action(async (cmd) => {
            const noproviderWallet = cmd.privateKey
            ? new Wallet(cmd.privateKey)
                : Wallet.fromMnemonic(
                    process.env.MNEMONIC ? process.env.MNEMONIC : ethTestConfig.mnemonic,
                    "m/44'/60'/0'/0/1"
                );


            const deployer = new Deployer(hre, noproviderWallet);
            const ethWallet = deployer.ethWallet;
            const l1Provider = deployer.ethWallet.provider;
                
            console.log(`Using deployer wallet: ${ethWallet.address}`);

            const gasPrice = cmd.gasPrice ? parseUnits(cmd.gasPrice, 'gwei') : await l1Provider.getGasPrice();
            console.log(`Using gas price: ${formatUnits(gasPrice, 'gwei')} gwei`);

            let nonce = cmd.nonce ? parseInt(cmd.nonce) : await ethWallet.getTransactionCount();
            console.log(`Using nonce: ${nonce}`);            
            
            let currentToPublishNames: string[] = [];
            let currentToPublish: string[] = [];
            for(const contract of Object.values(SYSTEM_CONTRACTS)) {
                let contractName = contract.codeName;

                let factoryDeps: string[] = [];
                if (contract.lang == Language.Solidity) {
                    const artifact = await deployer.loadArtifact(contractName);
                    factoryDeps = [
                        ...await deployer.extractFactoryDeps(artifact),
                        artifact.bytecode
                    ];
                } else {
                    // Yul files have only one dependency
                    factoryDeps = [
                        readYulBytecode(contract)
                    ];
                }

                nonce = await publishContract(
                    contractName,
                    factoryDeps,
                    currentToPublishNames,
                    currentToPublish,
                    nonce,
                    gasPrice,
                    deployer
                );
            }
            
            // Publish the remaining dependencies
            if(currentToPublish.length > 0) {
                await publishFactoryDeps(
                    currentToPublishNames,
                    currentToPublish,
                    deployer,
                    nonce,
                    gasPrice
                );
                nonce += 1;
            }

            // Publish the DefaultAccount as it is not included in the SYSTEM_CONTRACTS, since
            // it has no address.
            const [defaultAccountBytecodes, ] = await displayFactoryDeps('DefaultAccount', [(await deployer.loadArtifact('DefaultAccount')).bytecode], deployer);
            await publishFactoryDeps(
                ['DefaultAccount'],
                defaultAccountBytecodes,
                deployer,
                nonce,
                gasPrice
            );
            nonce += 1;

            // Publish the bootloader
            await publishBootloader(
                deployer,
                nonce,
                gasPrice
            );

            console.log('\nPublishing factory dependencies complete!');

            await outputDeploymentParams(deployer);
        });

    await program.parseAsync(process.argv);
}

main()
    .then(() => process.exit(0))
    .catch((err) => {
        console.error('Error:', err);
        process.exit(1);
    });
