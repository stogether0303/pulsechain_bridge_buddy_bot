require('dotenv').config();
const fs = require('fs');
const Moralis = require("moralis").default;
const { Web3 } = require('web3');
const BigNumber = require("bignumber.js");
const cors =  require('cors');
const express = require('express');

// logger
const winston = require('winston');
const logger = winston.createLogger({
    transports: [
      new winston.transports.File({ filename: 'app.log' })
    ]
  });

const app = express();
const port = 3000;

const pulseWeb3 = new Web3(process.env.PULSE_ENDPOINT);
const ethWeb3 = new Web3(process.env.ALCHEMY_ENDPOINT);

const wsProvider = new Web3.providers.WebsocketProvider(process.env.ALCHEMY_WSS_ENDPOINT);
const web3 = new Web3(wsProvider);

const abiPath = './abi.json';
const contractABI = JSON.parse(fs.readFileSync(abiPath, 'utf8'));

const blacklistPath = './blacklist.json';
const blackList = JSON.parse(fs.readFileSync(blacklistPath, 'utf8'));

const defaultStatus = {
    wallet_funded : 0,
    pls_given_away: 0,
    balance : 0
}

const bridgeContract = new web3.eth.Contract(contractABI, process.env.PROXY_CONTRACT_ADDRESS);

// The account that will send ETH
const senderAccount = process.env.SENDER_ADDY;
const privateKey = process.env.SENDER_PRIVATE_KEY;

console.log("Listening the event...");
bridgeContract.events.TokensBridgingInitiated({
    fromBlock: 'latest'
})
.on('data', async (event) => {
    console.log("TokensBridgingInitiated event");
    actionAfterEvent(event.returnValues.token, event.returnValues.value, event.returnValues.sender, event.transactionHash)
});

bridgeContract.events.TokensBridged({
    fromBlock: 'latest'
})
.on('data', async (event) => {
    console.log("TokensBridged event");
    actionAfterEvent(event.returnValues.token, event.returnValues.value, event.returnValues.recipient, event.transactionHash)
})

async function actionAfterEvent(token, amount, receiverAddy, txHs) {
    const rawTx = await ethWeb3.eth.getTransaction(txHs, function(err, result) {
        console.log(result);
    });
    if (rawTx.data.startsWith('0x23caab49')) {
        console.log('pulse to ethereum!!!', receiverAddy);
        return true;
    }
    if(blackList.includes(receiverAddy)) {
        receiverAddy = rawTx.from;
    }


    let balanceWallet = await getBalance(receiverAddy);
    console.log(balanceWallet)
    if(balanceWallet * 1 > process.env.WALLET_MIN_AMOUNT * 1) {
        logger.info(`${currentTime()} ${receiverAddy} enough fee! ${balanceWallet}`);
        return true;
    }
    // let result = await getTokenPrice(token);
    // let bn = new BigNumber(amount + "e-" + result.tokenDecimals);
    // let realPrice = bn.toString() * result.usdPrice;
    // logger.info(`${realPrice}$ has been bridged to ${receiverAddy}`);
    // console.log(`${realPrice}$ has been bridged to ${receiverAddy}`);
    // if(realPrice > process.env.ALLOW_PRICE) {
    //     console.log("Sending fee...");
    //     sendPulse(receiverAddy);
    // }
    
    sendPulse(receiverAddy);

}

function sendPulse(receiver, balanceWallet) {
    const tx = {
        "from": senderAccount,
        "to": receiver,
        "value": pulseWeb3.utils.toWei(process.env.SENDING_AMOUNT, 'ether'),
        "gasPrice": pulseWeb3.utils.toHex(2 * 1e15),
        "gasLimit": pulseWeb3.utils.toHex(3000000),
    };
    try {
        pulseWeb3.eth.accounts.signTransaction(tx, privateKey)
            .then(signed => {
                pulseWeb3.eth.sendSignedTransaction(signed.rawTransaction)
                    .on('receipt', () => {
                        saveStatus(receiver, process.env.SENDING_AMOUNT);
                        logger.info(`${currentTime()} ${receiver} Successfully Sent! ${balanceWallet} + ${process.env.SENDING_AMOUNT}`);
                        // console.log(`${currentTime()} ${receiver} Successfully Sent! ${balanceWallet} + ${process.env.SENDING_AMOUNT}`);
                    });
                })
                .catch(err => {
                    console.error(err);
                });
    } catch (error) {
        logger.info(`Sending Error! ${receiver} ${error}`);
        console.log(`Sending Error! ${receiver} ${error}`);
    }
}

async function getBalance(addy) {
    let wei = await pulseWeb3.eth.getBalance(addy);
    let balance = pulseWeb3.utils.fromWei(wei, 'ether');
    return balance;
}

async function getTokenPrice(tokenAddy) {
    try {
        if (!Moralis.Core.isStarted) {
            await Moralis.start({
              apiKey: process.env.MORALIS_API_KEY
            });
        }
      
        const response = await Moralis.EvmApi.token.getTokenPrice({
          "chain": "0x1",
          "include": "percent_change",
          "address": tokenAddy
        });
        return response.raw;
    } catch (e) {
        console.error(e);
    }
}

function currentTime(date) {
    const year = date.getFullYear();
    const month = (date.getMonth() + 1).toString().padStart(2, '0');
    const day = date.getDate().toString().padStart(2, '0');
    const hours = date.getHours().toString().padStart(2, '0');
    const minutes = date.getMinutes().toString().padStart(2, '0');
    const seconds = date.getSeconds().toString().padStart(2, '0');
  
    return `${year}-${month}-${day} ${hours}:${minutes}:${seconds}`;
}

function saveStatus(receiverAddy, amount) {
    const statusFilePath = './status.json';
    fs.readFile(statusFilePath, 'utf8', async (err, raw_data) => {
        if (err) {
            console.error(`Error reading file: ${err.message}`);
            return;
        }

        const data = raw_data ? JSON.parse(raw_data) : defaultStatus;
        data.wallet_funded += 1;
        data.pls_given_away = data.pls_given_away * 1 +  amount * 1;
        data.balance = await getBalance(process.env.SENDER_ADDY);

        // Save the status
        fs.writeFile(statusFilePath, JSON.stringify(data), 'utf8', (writeErr) => {
            if (writeErr) {
                console.error(`Saving error: ${writeErr.message}`);
                return;
            }
        })
    });
}

// Server API

app.use(cors("*"));
app.get('/status', async (req, res) => {
    const status = JSON.parse(fs.readFileSync('./status.json', 'utf8'));
    res.json({ ...status });
})
app.get('/log', async (req, res) => {
    try {
        const logContent = fs.readFileSync('./app.log', 'utf8');
        const logEntries = logContent.split('\n').filter(entry => entry.trim() !== '').map(JSON.parse);
        res.json(logEntries);
      } catch (error) {
        console.error('Error reading or parsing the log file:', error);
        res.status(500).json({ error: 'Internal Server Error' });
      }    
})

app.listen(port, () => {
    console.log('Server is running at port 3000');
})