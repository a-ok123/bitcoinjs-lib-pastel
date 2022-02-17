var Buffer = require('safe-buffer').Buffer
var baddress = require('./address')
var bcrypto = require('./crypto')
var bscript = require('./script')
var btemplates = require('./templates')
var coins = require('./coins')
var networks = require('./networks')
var ops = require('bitcoin-ops')
var typeforce = require('typeforce')
var types = require('./types')
var scriptTypes = btemplates.types
var SIGNABLE = [btemplates.types.P2PKH, btemplates.types.P2PK, btemplates.types.MULTISIG]
var P2SH = SIGNABLE.concat([btemplates.types.P2WPKH, btemplates.types.P2WSH])

var ECPair = require('./ecpair')
var ECSignature = require('./ecsignature')
var Transaction = require('./transaction')

var debug = require('debug')('bitgo:utxolib:txbuilder')

function supportedType (type) {
  return SIGNABLE.indexOf(type) !== -1
}

function supportedP2SHType (type) {
  return P2SH.indexOf(type) !== -1
}

function extractChunks (type, chunks, script) {
  var pubKeys = []
  var signatures = []
  switch (type) {
    case scriptTypes.P2PKH:
      // if (redeemScript) throw new Error('Nonstandard... P2SH(P2PKH)')
      pubKeys = chunks.slice(1)
      signatures = chunks.slice(0, 1)
      break

    case scriptTypes.P2PK:
      pubKeys[0] = script ? btemplates.pubKey.output.decode(script) : undefined
      signatures = chunks.slice(0, 1)
      break

    case scriptTypes.MULTISIG:
      if (script) {
        var multisig = btemplates.multisig.output.decode(script)
        pubKeys = multisig.pubKeys
      }

      signatures = chunks.slice(1).map(function (chunk) {
        return chunk.length === 0 ? undefined : chunk
      })
      break
  }

  return {
    pubKeys: pubKeys,
    signatures: signatures
  }
}
function expandInput (scriptSig, witnessStack) {
  if (scriptSig.length === 0 && witnessStack.length === 0) return {}

  var prevOutScript
  var prevOutType
  var scriptType
  var script
  var redeemScript
  var witnessScript
  var witnessScriptType
  var redeemScriptType
  var witness = false
  var p2wsh = false
  var p2sh = false
  var witnessProgram
  var chunks

  var scriptSigChunks = bscript.decompile(scriptSig)
  var sigType = btemplates.classifyInput(scriptSigChunks, true)
  if (sigType === scriptTypes.P2SH) {
    p2sh = true
    redeemScript = scriptSigChunks[scriptSigChunks.length - 1]
    redeemScriptType = btemplates.classifyOutput(redeemScript)
    prevOutScript = btemplates.scriptHash.output.encode(bcrypto.hash160(redeemScript))
    prevOutType = scriptTypes.P2SH
    script = redeemScript
  }

  var classifyWitness = btemplates.classifyWitness(witnessStack, true)
  if (classifyWitness === scriptTypes.P2WSH) {
    witnessScript = witnessStack[witnessStack.length - 1]
    witnessScriptType = btemplates.classifyOutput(witnessScript)
    p2wsh = true
    witness = true
    if (scriptSig.length === 0) {
      prevOutScript = btemplates.witnessScriptHash.output.encode(bcrypto.sha256(witnessScript))
      prevOutType = scriptTypes.P2WSH
      if (redeemScript !== undefined) {
        throw new Error('Redeem script given when unnecessary')
      }
      // bare witness
    } else {
      if (!redeemScript) {
        throw new Error('No redeemScript provided for P2WSH, but scriptSig non-empty')
      }
      witnessProgram = btemplates.witnessScriptHash.output.encode(bcrypto.sha256(witnessScript))
      if (!redeemScript.equals(witnessProgram)) {
        throw new Error('Redeem script didn\'t match witnessScript')
      }
    }

    if (!supportedType(btemplates.classifyOutput(witnessScript))) {
      throw new Error('unsupported witness script')
    }

    script = witnessScript
    scriptType = witnessScriptType
    chunks = witnessStack.slice(0, -1)
  } else if (classifyWitness === scriptTypes.P2WPKH) {
    witness = true
    var key = witnessStack[witnessStack.length - 1]
    var keyHash = bcrypto.hash160(key)
    if (scriptSig.length === 0) {
      prevOutScript = btemplates.witnessPubKeyHash.output.encode(keyHash)
      prevOutType = scriptTypes.P2WPKH
      if (typeof redeemScript !== 'undefined') {
        throw new Error('Redeem script given when unnecessary')
      }
    } else {
      if (!redeemScript) {
        throw new Error('No redeemScript provided for P2WPKH, but scriptSig wasn\'t empty')
      }
      witnessProgram = btemplates.witnessPubKeyHash.output.encode(keyHash)
      if (!redeemScript.equals(witnessProgram)) {
        throw new Error('Redeem script did not have the right witness program')
      }
    }

    scriptType = scriptTypes.P2PKH
    chunks = witnessStack
  } else if (redeemScript) {
    if (!supportedP2SHType(redeemScriptType)) {
      throw new Error('Bad redeemscript!')
    }

    script = redeemScript
    scriptType = redeemScriptType
    chunks = scriptSigChunks.slice(0, -1)
  } else {
    prevOutType = scriptType = btemplates.classifyInput(scriptSig)
    chunks = scriptSigChunks
  }

  var expanded = extractChunks(scriptType, chunks, script)

  var result = {
    pubKeys: expanded.pubKeys,
    signatures: expanded.signatures,
    prevOutScript: prevOutScript,
    prevOutType: prevOutType,
    signType: scriptType,
    signScript: script,
    witness: Boolean(witness)
  }

  if (p2sh) {
    result.redeemScript = redeemScript
    result.redeemScriptType = redeemScriptType
  }

  if (p2wsh) {
    result.witnessScript = witnessScript
    result.witnessScriptType = witnessScriptType
  }

  return result
}

// could be done in expandInput, but requires the original Transaction for hashForSignature
function fixMultisigOrder (input, transaction, vin, value, network) {
  if (input.redeemScriptType !== scriptTypes.MULTISIG || !input.redeemScript) return
  if (input.pubKeys.length === input.signatures.length) return

  network = network || networks.default
  var unmatched = input.signatures.concat()

  input.signatures = input.pubKeys.map(function (pubKey) {
    var keyPair = ECPair.fromPublicKeyBuffer(pubKey)
    var match

    // check for a signature
    unmatched.some(function (signature, i) {
      // skip if undefined || OP_0
      if (!signature) return false

      // TODO: avoid O(n) hashForSignature
      var parsed = ECSignature.parseScriptSignature(signature)
      var hash
      switch (network.coin) {
        case coins.BCH:
          hash = transaction.hashForCashSignature(vin, input.signScript, value, parsed.hashType)
          break
        case coins.BTG:
          hash = transaction.hashForGoldSignature(vin, input.signScript, value, parsed.hashType)
          break
        case coins.ZEC:
          if (value === undefined) {
            return false
          }
          hash = transaction.hashForZcashSignature(vin, input.signScript, value, parsed.hashType)
          break
        default:
          if (input.witness) {
            hash = transaction.hashForWitnessV0(vin, input.signScript, value, parsed.hashType)
          } else {
            hash = transaction.hashForSignature(vin, input.signScript, parsed.hashType)
          }
          break
      }

      // skip if signature does not match pubKey
      if (!keyPair.verify(hash, parsed.signature)) return false

      // remove matched signature from unmatched
      unmatched[i] = undefined
      match = signature

      return true
    })

    return match
  })
}

function expandOutput (script, scriptType, ourPubKey) {
  typeforce(types.Buffer, script)

  var scriptChunks = bscript.decompile(script)
  if (!scriptType) {
    scriptType = btemplates.classifyOutput(script)
  }

  var pubKeys = []

  switch (scriptType) {
    // does our hash160(pubKey) match the output scripts?
    case scriptTypes.P2PKH:
      if (!ourPubKey) break

      var pkh1 = scriptChunks[2]
      var pkh2 = bcrypto.hash160(ourPubKey)
      if (pkh1.equals(pkh2)) pubKeys = [ourPubKey]
      break

    // does our hash160(pubKey) match the output scripts?
    case scriptTypes.P2WPKH:
      if (!ourPubKey) break

      var wpkh1 = scriptChunks[1]
      var wpkh2 = bcrypto.hash160(ourPubKey)
      if (wpkh1.equals(wpkh2)) pubKeys = [ourPubKey]
      break

    case scriptTypes.P2PK:
      pubKeys = scriptChunks.slice(0, 1)
      break

    case scriptTypes.MULTISIG:
      pubKeys = scriptChunks.slice(1, -2)
      break

    default: return { scriptType: scriptType }
  }

  return {
    pubKeys: pubKeys,
    scriptType: scriptType,
    signatures: pubKeys.map(function () { return undefined })
  }
}

function checkP2SHInput (input, redeemScriptHash) {
  if (input.prevOutType) {
    if (input.prevOutType !== scriptTypes.P2SH) throw new Error('PrevOutScript must be P2SH')

    var prevOutScriptScriptHash = bscript.decompile(input.prevOutScript)[1]
    if (!prevOutScriptScriptHash.equals(redeemScriptHash)) throw new Error('Inconsistent hash160(RedeemScript)')
  }
}

function checkP2WSHInput (input, witnessScriptHash) {
  if (input.prevOutType) {
    if (input.prevOutType !== scriptTypes.P2WSH) throw new Error('PrevOutScript must be P2WSH')

    var scriptHash = bscript.decompile(input.prevOutScript)[1]
    if (!scriptHash.equals(witnessScriptHash)) throw new Error('Inconsistent sha25(WitnessScript)')
  }
}

function prepareInput (input, kpPubKey, redeemScript, witnessValue, witnessScript) {
  var expanded
  var prevOutType
  var prevOutScript

  var p2sh = false
  var p2shType
  var redeemScriptHash

  var witness = false
  var p2wsh = false
  var witnessType
  var witnessScriptHash

  var signType
  var signScript

  if (redeemScript && witnessScript) {
    redeemScriptHash = bcrypto.hash160(redeemScript)
    witnessScriptHash = bcrypto.sha256(witnessScript)
    checkP2SHInput(input, redeemScriptHash)

    if (!redeemScript.equals(btemplates.witnessScriptHash.output.encode(witnessScriptHash))) throw new Error('Witness script inconsistent with redeem script')

    expanded = expandOutput(witnessScript, undefined, kpPubKey)
    if (!expanded.pubKeys) throw new Error('WitnessScript not supported "' + bscript.toASM(redeemScript) + '"')

    prevOutType = btemplates.types.P2SH
    prevOutScript = btemplates.scriptHash.output.encode(redeemScriptHash)
    p2sh = witness = p2wsh = true
    p2shType = btemplates.types.P2WSH
    signType = witnessType = expanded.scriptType
    signScript = witnessScript
  } else if (redeemScript) {
    redeemScriptHash = bcrypto.hash160(redeemScript)
    checkP2SHInput(input, redeemScriptHash)

    expanded = expandOutput(redeemScript, undefined, kpPubKey)
    if (!expanded.pubKeys) throw new Error('RedeemScript not supported "' + bscript.toASM(redeemScript) + '"')

    prevOutType = btemplates.types.P2SH
    prevOutScript = btemplates.scriptHash.output.encode(redeemScriptHash)
    p2sh = true
    signType = p2shType = expanded.scriptType
    signScript = redeemScript
    witness = signType === btemplates.types.P2WPKH
  } else if (witnessScript) {
    witnessScriptHash = bcrypto.sha256(witnessScript)
    checkP2WSHInput(input, witnessScriptHash)

    expanded = expandOutput(witnessScript, undefined, kpPubKey)
    if (!expanded.pubKeys) throw new Error('WitnessScript not supported "' + bscript.toASM(redeemScript) + '"')

    prevOutType = btemplates.types.P2WSH
    prevOutScript = btemplates.witnessScriptHash.output.encode(witnessScriptHash)
    witness = p2wsh = true
    signType = witnessType = expanded.scriptType
    signScript = witnessScript
  } else if (input.prevOutType) {
    // embedded scripts are not possible without a redeemScript
    if (input.prevOutType === scriptTypes.P2SH ||
      input.prevOutType === scriptTypes.P2WSH) {
      throw new Error('PrevOutScript is ' + input.prevOutType + ', requires redeemScript')
    }

    prevOutType = input.prevOutType
    prevOutScript = input.prevOutScript
    expanded = expandOutput(input.prevOutScript, input.prevOutType, kpPubKey)
    if (!expanded.pubKeys) return

    witness = (input.prevOutType === scriptTypes.P2WPKH)
    signType = prevOutType
    signScript = prevOutScript
  } else {
    prevOutScript = btemplates.pubKeyHash.output.encode(bcrypto.hash160(kpPubKey))
    expanded = expandOutput(prevOutScript, scriptTypes.P2PKH, kpPubKey)

    prevOutType = scriptTypes.P2PKH
    witness = false
    signType = prevOutType
    signScript = prevOutScript
  }

  if (signType === scriptTypes.P2WPKH) {
    signScript = btemplates.pubKeyHash.output.encode(btemplates.witnessPubKeyHash.output.decode(signScript))
  }

  if (p2sh) {
    input.redeemScript = redeemScript
    input.redeemScriptType = p2shType
  }

  if (p2wsh) {
    input.witnessScript = witnessScript
    input.witnessScriptType = witnessType
  }

  input.pubKeys = expanded.pubKeys
  input.signatures = expanded.signatures
  input.signScript = signScript
  input.signType = signType
  input.prevOutScript = prevOutScript
  input.prevOutType = prevOutType
  input.witness = witness
}

function buildStack (type, signatures, pubKeys, allowIncomplete) {
  if (type === scriptTypes.P2PKH) {
    if (signatures.length === 1 && Buffer.isBuffer(signatures[0]) && pubKeys.length === 1) return btemplates.pubKeyHash.input.encodeStack(signatures[0], pubKeys[0])
  } else if (type === scriptTypes.P2PK) {
    if (signatures.length === 1 && Buffer.isBuffer(signatures[0])) return btemplates.pubKey.input.encodeStack(signatures[0])
  } else if (type === scriptTypes.MULTISIG) {
    if (signatures.length > 0) {
      signatures = signatures.map(function (signature) {
        return signature || ops.OP_0
      })
      if (!allowIncomplete) {
        // remove blank signatures
        signatures = signatures.filter(function (x) { return x !== ops.OP_0 })
      }

      return btemplates.multisig.input.encodeStack(signatures)
    }
  } else {
    throw new Error('Not yet supported')
  }

  if (!allowIncomplete) throw new Error('Not enough signatures provided')
  return []
}

function buildInput (input, allowIncomplete) {
  var scriptType = input.prevOutType
  var sig = []
  var witness = []

  if (supportedType(scriptType)) {
    sig = buildStack(scriptType, input.signatures, input.pubKeys, allowIncomplete)
  }

  var p2sh = false
  if (scriptType === btemplates.types.P2SH) {
    // We can remove this error later when we have a guarantee prepareInput
    // rejects unsignable scripts - it MUST be signable at this point.
    if (!allowIncomplete && !supportedP2SHType(input.redeemScriptType)) {
      throw new Error('Impossible to sign this type')
    }

    if (supportedType(input.redeemScriptType)) {
      sig = buildStack(input.redeemScriptType, input.signatures, input.pubKeys, allowIncomplete)
    }

    // If it wasn't SIGNABLE, it's witness, defer to that
    if (input.redeemScriptType) {
      p2sh = true
      scriptType = input.redeemScriptType
    }
  }

  switch (scriptType) {
    // P2WPKH is a special case of P2PKH
    case btemplates.types.P2WPKH:
      witness = buildStack(btemplates.types.P2PKH, input.signatures, input.pubKeys, allowIncomplete)
      break

    case btemplates.types.P2WSH:
      // We can remove this check later
      if (!allowIncomplete && !supportedType(input.witnessScriptType)) {
        throw new Error('Impossible to sign this type')
      }

      if (supportedType(input.witnessScriptType)) {
        witness = buildStack(input.witnessScriptType, input.signatures, input.pubKeys, allowIncomplete)
        witness.push(input.witnessScript)
        scriptType = input.witnessScriptType
      }
      break
  }

  // append redeemScript if necessary
  if (p2sh) {
    sig.push(input.redeemScript)
  }

  return {
    type: scriptType,
    script: bscript.compile(sig),
    witness: witness
  }
}

// By default, assume is a Pastel Coin style transaction
function TransactionBuilder (network, version = 1, maximumFeeRate) {
  this.prevTxMap = {}
  this.network = network || networks.default

  // WARNING: This is __NOT__ to be relied on, its just another potential safety mechanism (safety in-depth)
  this.maximumFeeRate = maximumFeeRate || 2500

  this.inputs = []
  this.tx = new Transaction(this.network)

  this.setVersion(version)
}

TransactionBuilder.prototype.setLockTime = function (locktime) {
  typeforce(types.UInt32, locktime)

  // if any signatures exist, throw
  if (this.inputs.some(function (input) {
    if (!input.signatures) return false

    return input.signatures.some(function (s) { return s })
  })) {
    throw new Error('No, this would invalidate signatures')
  }

  this.tx.locktime = locktime
}

Transaction.OVERWINTER_VERSION_GROUP_ID = 0x03C48270;
Transaction.SAPLING_VERSION_GROUP_ID = 0x892F2085;

TransactionBuilder.prototype.setVersionGroupId = function (versionGroupId) {
  if (!(coins.isZcash(this.network) && this.tx.isOverwinterCompatible())) {
    throw new Error('versionGroupId can only be set for Zcash or compatible networks starting at overwinter version. Current network coin: ' +
      this.network.coin + ', version: ' + this.tx.version)
  }
  typeforce(types.UInt32, versionGroupId)
  this.tx.versionGroupId = versionGroupId
}

TransactionBuilder.prototype.setVersion = function (version) {
  typeforce(types.UInt32, version)

  this.tx.version = version

  if (coins.isZcash(this.network)) {
    if (version >= 3)
    {
      if (version > Transaction.ZCASH_SAPLING_VERSION)
      {
        throw new Error('Unsupported Zcash transaction')
      }
      this.tx.overwintered = 1;
      this.setVersionGroupId(version === 3 ? Transaction.OVERWINTER_VERSION_GROUP_ID : Transaction.SAPLING_VERSION_GROUP_ID)
    }
    else
    {
      this.tx.overwintered = 0;
    }
  }
}

TransactionBuilder.prototype.setExpiryHeight = function (expiryHeight) {
  if (!(coins.isZcash(this.network) && this.tx.isOverwinterCompatible())) {
    throw new Error('expiryHeight can only be set for Zcash starting at overwinter version. Current network coin: ' +
      this.network.coin + ', version: ' + this.tx.version)
  }
  typeforce(types.UInt32, expiryHeight)
  this.tx.expiryHeight = expiryHeight
}

Transaction.prototype.setOverwinter = function (expiry, versionGroupId) {
  this.setVersion(3);
  this.expiry=(expiry||0);
}

Transaction.prototype.setSapling = function (expiry, versionGroupId) {
  this.setVersion(4);
  this.expiry=(expiry||0);
}

TransactionBuilder.prototype.setJoinSplits = function (transaction) {
  if (!(coins.isZcash(this.network) && this.tx.supportsJoinSplits())) {
    throw new Error('joinsplits can only be set for Zcash starting at version 2. Current network coin: ' +
      this.network.coin + ', version: ' + this.tx.version)
  }
  if (transaction && transaction.joinsplits) {
    this.tx.joinsplits = transaction.joinsplits.map(function (txJoinsplit) {
      return {
        vpubOld: txJoinsplit.vpubOld,
        vpubNew: txJoinsplit.vpubNew,
        anchor: txJoinsplit.anchor,
        nullifiers: txJoinsplit.nullifiers,
        commitments: txJoinsplit.commitments,
        ephemeralKey: txJoinsplit.ephemeralKey,
        randomSeed: txJoinsplit.randomSeed,
        macs: txJoinsplit.macs,
        zproof: txJoinsplit.zproof,
        ciphertexts: txJoinsplit.ciphertexts
      }
    })

    this.tx.joinsplitPubkey = transaction.joinsplitPubkey
    this.tx.joinsplitSig = transaction.joinsplitSig
    return
  }
  throw new Error('Invalid transaction with joinsplits')
}

TransactionBuilder.fromTransaction = function (transaction, network) {
  var txbNetwork = network || networks.default
  var txb = new TransactionBuilder(txbNetwork)

  if (txb.network.coin !== transaction.network.coin) {
    throw new Error('This transaction is incompatible with the transaction builder')
  }

  // Copy transaction fields
  txb.setVersion(transaction.version, transaction.overwintered)
  txb.setLockTime(transaction.locktime)

  if (coins.isZcash(txbNetwork)) {
    // Copy Zcash overwinter fields. If the transaction builder is not for Zcash, they will be omitted
    if (txb.tx.isOverwinterCompatible()) {
      txb.setVersionGroupId(transaction.versionGroupId)
      txb.setExpiryHeight(transaction.expiryHeight)
    }
    // We don't support protected transactions but we copy the joinsplits for consistency. However, the transaction
    // builder will fail when we try to sign one of these transactions
    if (txb.tx.supportsJoinSplits()) {
      txb.setJoinSplits(transaction)
    }
  }
  // Copy outputs (done first to avoid signature invalidation)
  transaction.outs.forEach(function (txOut) {
    txb.addOutput(txOut.script, txOut.value)
  })

  // Copy inputs
  transaction.ins.forEach(function (txIn) {
    txb.__addInputUnsafe(txIn.hash, txIn.index, {
      sequence: txIn.sequence,
      script: txIn.script,
      witness: txIn.witness,
      value: txIn.value
    })
  })

  // fix some things not possible through the public API
  txb.inputs.forEach(function (input, i) {
    fixMultisigOrder(input, transaction, i, input.value, txbNetwork)
  })

  return txb
}

TransactionBuilder.prototype.addInput = function (txHash, vout, sequence, prevOutScript) {
  if (!this.__canModifyInputs()) {
    throw new Error('No, this would invalidate signatures')
  }

  var value

  // is it a hex string?
  if (typeof txHash === 'string') {
    // transaction hashs's are displayed in reverse order, un-reverse it
    txHash = Buffer.from(txHash, 'hex').reverse()

  // is it a Transaction object?
  } else if (txHash instanceof Transaction) {
    var txOut = txHash.outs[vout]
    prevOutScript = txOut.script
    value = txOut.value

    txHash = txHash.getHash()
  }

  if (Transaction.isCoinbaseHash(txHash)) {
    return this.__addInputUnsafe(txHash, vout, {
      sequence: sequence,
      scriptSig: prevOutScript,
    })
  }
  else {
    return this.__addInputUnsafe(txHash, vout, {
      sequence: sequence,
      prevOutScript: prevOutScript,
      value: value
    })
  }
}

TransactionBuilder.prototype.__addInputUnsafe = function (txHash, vout, options) {
  var input = {}

  if (Transaction.isCoinbaseHash(txHash)) {
    var vin = this.tx.addInput(txHash, vout, options.sequence, options.scriptSig)
    input = {
      pubKeys: [],
      signatures: [],
      signScript: options.scriptSig,
    }
    this.inputs[vin] = input
    //throw new Error('coinbase inputs not supported')
    return 0;
  }

  var prevTxOut = txHash.toString('hex') + ':' + vout
  if (this.prevTxMap[prevTxOut] !== undefined) throw new Error('Duplicate TxOut: ' + prevTxOut)

  // derive what we can from the scriptSig
  if (options.script !== undefined) {
    input = expandInput(options.script, options.witness || [])
  }

  // if an input value was given, retain it
  if (options.value !== undefined) {
    input.value = options.value
  }

  // derive what we can from the previous transactions output script
  if (!input.prevOutScript && options.prevOutScript) {
    var prevOutType

    if (!input.pubKeys && !input.signatures) {
      var expanded = expandOutput(options.prevOutScript)

      if (expanded.pubKeys) {
        input.pubKeys = expanded.pubKeys
        input.signatures = expanded.signatures
      }

      prevOutType = expanded.scriptType
    }

    input.prevOutScript = options.prevOutScript
    input.prevOutType = prevOutType || btemplates.classifyOutput(options.prevOutScript)
  }

  var vin = this.tx.addInput(txHash, vout, options.sequence, options.scriptSig)
  this.inputs[vin] = input
  this.prevTxMap[prevTxOut] = vin
  return vin
}

TransactionBuilder.prototype.addOutput = function (scriptPubKey, value) {
  if (!this.__canModifyOutputs()) {
    throw new Error('No, this would invalidate signatures')
  }

  // Attempt to get a script if it's a base58 address string
  if (typeof scriptPubKey === 'string') {
    scriptPubKey = baddress.toOutputScript(scriptPubKey, this.network)
  }

  return this.tx.addOutput(scriptPubKey, value)
}

TransactionBuilder.prototype.build = function () {
  return this.__build(false)
}
TransactionBuilder.prototype.buildIncomplete = function () {
  return this.__build(true)
}

TransactionBuilder.prototype.__build = function (allowIncomplete) {
  if (!allowIncomplete) {
    if (!this.tx.ins.length) throw new Error('Transaction has no inputs')
    if (!this.tx.outs.length) throw new Error('Transaction has no outputs')
  }

  var tx = this.tx.clone()
  if (Transaction.isCoinbaseHash(tx.ins[0].hash))
  {
    return tx;
  }

  // Create script signatures from inputs
  this.inputs.forEach(function (input, i) {
    var scriptType = input.witnessScriptType || input.redeemScriptType || input.prevOutType
    if (!scriptType && !allowIncomplete) throw new Error('Transaction is not complete')
    var result = buildInput(input, allowIncomplete)

    // skip if no result
    if (!allowIncomplete) {
      if (!supportedType(result.type) && result.type !== btemplates.types.P2WPKH) {
        throw new Error(result.type + ' not supported')
      }
    }

    tx.setInputScript(i, result.script)
    tx.setWitness(i, result.witness)
  })

  if (!allowIncomplete) {
    // do not rely on this, its merely a last resort
    if (this.__overMaximumFees(tx.virtualSize())) {
      throw new Error('Transaction has absurd fees')
    }
  }

  return tx
}

function canSign (input) {
  return input.prevOutScript !== undefined &&
    input.signScript !== undefined &&
    input.pubKeys !== undefined &&
    input.signatures !== undefined &&
    input.signatures.length === input.pubKeys.length &&
    input.pubKeys.length > 0 &&
    (
      input.witness === false ||
      (input.witness === true && input.value !== undefined)
    )
}

TransactionBuilder.prototype.sign = function (vin, keyPair, redeemScript, hashType, witnessValue, witnessScript) {
  debug('Signing transaction: (input: %d, hashType: %d, witnessVal: %s, witnessScript: %j)', vin, hashType, witnessValue, witnessScript)
  debug('Transaction Builder network: %j', this.network)
  console.log('Transaction builder initialized')

  console.log('THIS NETWORK')
  console.log(this.network)
  console.log('_____________________________')

  // TODO: remove keyPair.network matching in 4.0.0
  if (keyPair.network && keyPair.network !== this.network) throw new TypeError('Inconsistent network')
  console.log('Consistent network')
  if (!this.inputs[vin]) throw new Error('No input at index: ' + vin)
  hashType = hashType || Transaction.SIGHASH_ALL
  console.log('Inputs detected')

  var input = this.inputs[vin]

  // if redeemScript was previously provided, enforce consistency
  if (input.redeemScript !== undefined &&
      redeemScript &&
      !input.redeemScript.equals(redeemScript)) {
    throw new Error('Inconsistent redeemScript')
  }
  console.log('Consistent redeemscript')

  var kpPubKey = keyPair.publicKey || keyPair.getPublicKeyBuffer()
  if (!canSign(input)) {
    if (witnessValue !== undefined) {
      if (input.value !== undefined && input.value !== witnessValue) throw new Error('Input didn\'t match witnessValue')
      typeforce(types.Satoshi, witnessValue)
      input.value = witnessValue
    }
    console.log('Input matched witness value')
    console.log('Preparing input for signing')

    debug('Preparing input %d for signing', vin)

    if (!canSign(input)) prepareInput(input, kpPubKey, redeemScript, witnessValue, witnessScript)
    console.log('input prepared')
    if (!canSign(input)) throw Error(input.prevOutType + ' not supported')
  }

  console.log('ready to sign')
  console.log('VIN: ')
  console.log(vin)
  console.log('input.signScript: ')
  console.log(input.signScript)
  console.log('witnessValue: ')
  console.log(witnessValue)
  console.log('hashType: ')
  console.log(hashType)
  // ready to sign
  var signatureHash
  if (coins.isBitcoinGold(this.network)) {
    signatureHash = this.tx.hashForGoldSignature(vin, input.signScript, witnessValue, hashType, input.witness)
    debug('Calculated BTG sighash (%s)', signatureHash.toString('hex'))
    console.log('Calculated BTG sighash (%s)', signatureHash.toString('hex'))
  } else if (coins.isBitcoinCash(this.network)) {
    signatureHash = this.tx.hashForCashSignature(vin, input.signScript, witnessValue, hashType)
    debug('Calculated BCH sighash (%s)', signatureHash.toString('hex'))
    console.log('Calculated BCH sighash (%s)', signatureHash.toString('hex'))
  } else if (coins.isZcash(this.network)) {
    signatureHash = this.tx.hashForZcashSignature(vin, input.signScript, witnessValue, hashType)
    debug('Calculated ZEC sighash (%s)', signatureHash.toString('hex'))
    console.log('Calculated ZEC sighash (%s)', signatureHash.toString('hex'))
  } else if (coins.isVerus(this.network)) {
    signatureHash = this.tx.hashForVerusSignature(vin, input.signScript, witnessValue, hashType)
    debug('Calculated VRSC sighash (%s)', signatureHash.toString('hex'))
    console.log('Calculated VRSC sighash (%s)', signatureHash.toString('hex'))
  } else {
    if (input.witness) {
      signatureHash = this.tx.hashForWitnessV0(vin, input.signScript, witnessValue, hashType)
      debug('Calculated witnessv0 sighash (%s)', signatureHash)
      console.log('Calculated witnessv0 sighash (%s)', signatureHash)
    } else {
      signatureHash = this.tx.hashForSignature(vin, input.signScript, hashType)
      debug('Calculated sighash (%s)', signatureHash.toString('hex'))
      console.log('Calculated sighash (%s)', signatureHash.toString('hex'))
    }
  }

  console.log('sighash calculated')

  // enforce in order signing of public keys
  var signed = input.pubKeys.some(function (pubKey, i) {
    if (!kpPubKey.equals(pubKey)) return false
    if (input.signatures[i]) throw new Error('Signature already exists')
    if (kpPubKey.length !== 33 &&
      input.signType === scriptTypes.P2WPKH) throw new Error('BIP143 rejects uncompressed public keys in P2WPKH or P2WSH')

    var signature = keyPair.sign(signatureHash)
    if (Buffer.isBuffer(signature)) signature = ECSignature.fromRSBuffer(signature)

    debug('Produced signature (r: %s, s: %s)', signature.r, signature.s)

    input.signatures[i] = signature.toScriptSignature(hashType)
    return true
  })

  if (!signed) throw new Error('Key pair cannot sign for this input')
}

function signatureHashType (buffer) {
  return buffer.readUInt8(buffer.length - 1)
}

TransactionBuilder.prototype.__canModifyInputs = function () {
  return this.inputs.every(function (input) {
    // any signatures?
    if (input.signatures === undefined) return true

    return input.signatures.every(function (signature) {
      if (!signature) return true
      var hashType = signatureHashType(signature)

      // if SIGHASH_ANYONECANPAY is set, signatures would not
      // be invalidated by more inputs
      return hashType & Transaction.SIGHASH_ANYONECANPAY
    })
  })
}

TransactionBuilder.prototype.__canModifyOutputs = function () {
  var nInputs = this.tx.ins.length
  var nOutputs = this.tx.outs.length

  return this.inputs.every(function (input) {
    if (input.signatures === undefined) return true

    return input.signatures.every(function (signature) {
      if (!signature) return true
      var hashType = signatureHashType(signature)

      var hashTypeMod = hashType & 0x1f
      if (hashTypeMod === Transaction.SIGHASH_NONE) return true
      if (hashTypeMod === Transaction.SIGHASH_SINGLE) {
        // if SIGHASH_SINGLE is set, and nInputs > nOutputs
        // some signatures would be invalidated by the addition
        // of more outputs
        return nInputs <= nOutputs
      }
    })
  })
}

TransactionBuilder.prototype.__overMaximumFees = function (bytes) {
  // not all inputs will have .value defined
  var incoming = this.inputs.reduce(function (a, x) { return a + (x.value >>> 0) }, 0)

  // but all outputs do, and if we have any input value
  // we can immediately determine if the outputs are too small
  var outgoing = this.tx.outs.reduce(function (a, x) { return a + x.value }, 0)
  var fee = incoming - outgoing
  var feeRate = fee / bytes

  return feeRate > this.maximumFeeRate
}

module.exports = TransactionBuilder
