import * as anchor from '@project-serum/anchor';
import FormData from 'form-data';
import fs from 'fs';
import log from 'loglevel';
import fetch from 'node-fetch';
import { ARWEAVE_PAYMENT_WALLET, EXTENSION_AVI, EXTENSION_GIF, EXTENSION_JPEG, EXTENSION_MP4, EXTENSION_PNG, EXTENSION_WMV, MIMETYPE_AVI, MIMETYPE_GIF, MIMETYPE_JPEG, MIMETYPE_MP4, MIMETYPE_PNG, MIMETYPE_WMV } from '../constants';
import { sendTransactionWithRetryWithKeypair } from '../transactions';

async function upload(data: FormData, manifest, index) {
  log.debug(`trying to upload ${index}.png: ${manifest.name}`);
  return await (
    await fetch(
      'https://us-central1-principal-lane-200702.cloudfunctions.net/uploadFile4',
      {
        method: 'POST',
        // @ts-ignore
        body: data,
      },
    )
  ).json();
}

function appendData(image){
  var res = {
    filename: '',
    contentType: ''
  };
  if(image.endsWith(EXTENSION_PNG)){
    res.filename = 'image'+ EXTENSION_PNG;
    res.contentType = MIMETYPE_PNG;
  }else if(image.endsWith(EXTENSION_GIF)){
    res.filename = 'image' + EXTENSION_GIF;
    res.contentType = MIMETYPE_GIF;
  }else if(image.endsWith(EXTENSION_AVI)){
    res.filename = 'image' + EXTENSION_AVI;
    res.contentType = MIMETYPE_AVI;
  }else if(image.endsWith(EXTENSION_WMV)){
    res.filename = 'image' + EXTENSION_WMV;
    res.contentType = MIMETYPE_WMV;
  }else{
    var ext = image.split('.')[1];
    if(EXTENSION_MP4.includes(ext)){
      res.filename = 'image.' + ext;
      res.contentType = MIMETYPE_MP4;
    }else if(EXTENSION_JPEG.includes(ext)){
      res.filename = 'image.' + ext;
      res.contentType = MIMETYPE_JPEG;
    }
  }
  return res;
}

export async function arweaveUpload(
  walletKeyPair,
  anchorProgram,
  env,
  image,
  manifestBuffer,
  manifest,
  index,
) {
  const storageCost = 10;

  const instructions = [
    anchor.web3.SystemProgram.transfer({
      fromPubkey: walletKeyPair.publicKey,
      toPubkey: ARWEAVE_PAYMENT_WALLET,
      lamports: storageCost,
    }),
  ];

  const tx = await sendTransactionWithRetryWithKeypair(
    anchorProgram.provider.connection,
    walletKeyPair,
    instructions,
    [],
    'single',
  );
  log.debug('transaction for arweave payment:', tx);

  const data = new FormData();
  data.append('transaction', tx['txid']);
  data.append('env', env);
  var fileAttrs = appendData(image);
  data.append('file[]', fs.createReadStream(image), {
    filename: fileAttrs.filename,
    contentType: fileAttrs.contentType,
  });
  data.append('file[]', manifestBuffer, 'metadata.json');

  const result = await upload(data, manifest, index);

  const metadataFile = result.messages?.find(
    m => m.filename === 'manifest.json',
  );
  if (metadataFile?.transactionId) {
    const link = `https://arweave.net/${metadataFile.transactionId}`;
    log.debug(`File uploaded: ${link}`);
    return link;
  } else {
    // @todo improve
    throw new Error(`No transaction ID for upload: ${index}`);
  }
}
