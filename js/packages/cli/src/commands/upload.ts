import { EXTENSION_AVI, EXTENSION_GIF, EXTENSION_JPEG, EXTENSION_MP4, EXTENSION_PNG, EXTENSION_WMV } from '../helpers/constants';
import path from 'path';
import {
  createConfig,
  loadCandyProgram,
  loadWalletKey,
} from '../helpers/accounts';
import { PublicKey } from '@solana/web3.js';
import fs from 'fs';
import BN from 'bn.js';
import { loadCache, saveCache } from '../helpers/cache';
import log from 'loglevel';
import { arweaveUpload } from '../helpers/upload/arweave';
import { ipfsCreds, ipfsUpload } from '../helpers/upload/ipfs';
import { chunks } from '../helpers/various';

export async function upload(
  files: string[],
  cacheName: string,
  env: string,
  keypair: string,
  totalNFTs: number,
  storage: string,
  retainAuthority: boolean,
  ipfsCredentials: ipfsCreds,
): Promise<boolean> {
  let uploadSuccessful = true;

  const savedContent = loadCache(cacheName, env);
  const cacheContent = savedContent || {};

  if (!cacheContent.program) {
    cacheContent.program = {};
  }

  let existingInCache = [];
  if (!cacheContent.items) {
    cacheContent.items = {};
  } else {
    existingInCache = Object.keys(cacheContent.items);
  }

  const seen = {};
  const newFiles = [];
  files.forEach(f => {
      var mergedExtensions = EXTENSION_MP4.concat(EXTENSION_JPEG, EXTENSION_PNG, EXTENSION_GIF, EXTENSION_WMV, EXTENSION_AVI);
      for(var i = 0; i < mergedExtensions.length; i++){
        if(!seen[f.replace(mergedExtensions[i], '').split('/').pop()]){
          seen[f.replace(mergedExtensions[i], '').split('/').pop()] = true;
          newFiles.push(f);
          break;
        }
      }
  });
  console.log(existingInCache)
  existingInCache.forEach(f => {
    if (!seen[f]) {
      seen[f] = true;
      newFiles.push(f + '.png');
    }
  });

  const images = newFiles.filter(val => {
    //path.extname(val) === EXTENSION_PNG || path.extname(val) === EXTENSION_GIF || path.extname(val) === EXTENSION_WMV || path.extname(val) === EXTENSION_AVI ||
    var mergedExtensions = EXTENSION_MP4.concat(EXTENSION_JPEG, EXTENSION_PNG, EXTENSION_GIF, EXTENSION_WMV, EXTENSION_AVI);
    for(var i = 0; i < mergedExtensions.length; i++){
      if(path.extname(val) === mergedExtensions[i]){
        return true;
      }
    }
  });
  const SIZE = images.length;
  const walletKeyPair = loadWalletKey(keypair);
  const anchorProgram = await loadCandyProgram(walletKeyPair, env);

  let config = cacheContent.program.config
    ? new PublicKey(cacheContent.program.config)
    : undefined;

  for (let i = 0; i < SIZE; i++) {
    const image = images[i];
    const imageName = path.basename(image);
    var mergedExtensions = EXTENSION_MP4.concat(EXTENSION_JPEG, EXTENSION_PNG, EXTENSION_GIF, EXTENSION_WMV, EXTENSION_AVI);
    var index;
    var imageExt;
    for(var n = 0; n < mergedExtensions.length; n++){
      if(imageName.endsWith(mergedExtensions[n])){
        index = imageName.replace(mergedExtensions[n], '');
        imageExt = mergedExtensions[n];
      }
    }
    log.debug(`Processing file: ${i}`);
    if (i % 50 === 0) {
      log.info(`Processing file: ${i}`);
    }

    let link = cacheContent?.items?.[index]?.link;
    if (!link || !cacheContent.program.uuid) {
      
      const manifestPath = image.split('.')[0] + '.json';
      const manifestContent = fs
        .readFileSync(manifestPath)
        .toString()
        .replace(imageName, 'image' + imageExt)
        .replace(imageName, 'image' + imageExt);
      const manifest = JSON.parse(manifestContent);

      const manifestBuffer = Buffer.from(JSON.stringify(manifest));

      if (i === 0 && !cacheContent.program.uuid) {
        // initialize config
        log.info(`initializing config`);
        try {
          const res = await createConfig(anchorProgram, walletKeyPair, {
            maxNumberOfLines: new BN(totalNFTs),
            symbol: manifest.symbol,
            sellerFeeBasisPoints: manifest.seller_fee_basis_points,
            isMutable: true,
            maxSupply: new BN(0),
            retainAuthority: retainAuthority,
            creators: manifest.properties.creators.map(creator => {
              return {
                address: new PublicKey(creator.address),
                verified: true,
                share: creator.share,
              };
            }),
          });
          cacheContent.program.uuid = res.uuid;
          cacheContent.program.config = res.config.toBase58();
          config = res.config;

          log.info(
            `initialized config for a candy machine with publickey: ${res.config.toBase58()}`,
          );

          saveCache(cacheName, env, cacheContent);
        } catch (exx) {
          log.error('Error deploying config to Solana network.', exx);
          throw exx;
        }
      }

      if (!link) {
        try {
          if (storage === 'arweave') {
            link = await arweaveUpload(
              walletKeyPair,
              anchorProgram,
              env,
              image,
              manifestBuffer,
              manifest,
              index,
            );
          } else if (storage === 'ipfs') {
            link = await ipfsUpload(ipfsCredentials, image, manifestBuffer);
          }

          if (link) {
            log.debug('setting cache for ', index);
            cacheContent.items[index] = {
              link,
              name: manifest.name,
              onChain: false,
            };
            cacheContent.authority = walletKeyPair.publicKey.toBase58();
            saveCache(cacheName, env, cacheContent);
          }
        } catch (er) {
          uploadSuccessful = false;
          log.error(`Error uploading file ${index}`, er);
        }
      }
    }
  }

  const keys = Object.keys(cacheContent.items);
  try {
    await Promise.all(
      chunks(Array.from(Array(keys.length).keys()), 1000).map(
        async allIndexesInSlice => {
          for (
            let offset = 0;
            offset < allIndexesInSlice.length;
            offset += 10
          ) {
            const indexes = allIndexesInSlice.slice(offset, offset + 10);
            const onChain = indexes.filter(i => {
              const index = keys[i];
              return cacheContent.items[index]?.onChain || false;
            });
            const ind = keys[indexes[0]];

            if (onChain.length != indexes.length) {
              log.info(
                `Writing indices ${ind}-${keys[indexes[indexes.length - 1]]}`,
              );
              try {
                await anchorProgram.rpc.addConfigLines(
                  ind,
                  indexes.map(i => ({
                    uri: cacheContent.items[keys[i]].link,
                    name: cacheContent.items[keys[i]].name,
                  })),
                  {
                    accounts: {
                      config,
                      authority: walletKeyPair.publicKey,
                    },
                    signers: [walletKeyPair],
                  },
                );
                indexes.forEach(i => {
                  cacheContent.items[keys[i]] = {
                    ...cacheContent.items[keys[i]],
                    onChain: true,
                  };
                });
                saveCache(cacheName, env, cacheContent);
              } catch (e) {
                log.error(
                  `saving config line ${ind}-${
                    keys[indexes[indexes.length - 1]]
                  } failed`,
                  e,
                );
                uploadSuccessful = false;
              }
            }
          }
        },
      ),
    );
  } catch (e) {
    log.error(e);
  } finally {
    saveCache(cacheName, env, cacheContent);
  }
  console.log(`Done. Successful = ${uploadSuccessful}.`);
  return uploadSuccessful;
}
