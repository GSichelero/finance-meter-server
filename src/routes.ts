const express = require('express');
const bodyParser = require('body-parser');
var googleFinance = require('google-finance');
const { Client } = require('pg')
const multer = require('multer');
var XLSX = require('node-xlsx');
const yahooFinance = require('yahoo-finance2').default;

var manage_data = require('./utils/manage_data');


const connectionString = process.env.DATABASE_URL;

const client = new Client({
    connectionString,
})
client.connect()

// if table finance_data does not exist, create it
// finance_data is the table name, and the columns are: date, movement, product, quantity, unit_price, operation_value
client.query('CREATE TABLE IF NOT EXISTS finance_data (date date, movement varchar(100), product varchar(100), quantity numeric(10, 2), unit_price numeric(10, 2), operation_value numeric(10, 2))')

const routes = express()

// routes.use(bodyParser.urlencoded({ extended: true }))
routes.use(express.json({limit: '50mb'}));
routes.use(express.urlencoded({limit: '50mb'}));

// routes.use(routes.router)

routes.get('/', (request: any, response: any) => {
  // select all rows from finance_data
  client.query('SELECT * FROM finance_data', (err: any, res: any) => {
    if (err) {
      console.log(err.stack)
    } else {
      console.log(res.rows)
    }
  })
  return response.json({ message: 'Hello World' })
})


routes.get('/stock/:name', async function(request: any, response: any) {
  let queryOptions = { period1: '2022-02-01', period2: '2022-03-01'};
  try {
    let quotes = await yahooFinance.historical(request.params.name, queryOptions);
    response.json(quotes);
  } catch (err) {
    console.log(err);
  }
})


routes.get('/get-financial-data', async function(request: any, response: any) {
  return response.json(manage_data.filterData(await manage_data.getFinancialData()));
})


routes.get('/get-financial-dividends', async function(request: any, response: any) {
  return response.json(await manage_data.getFinancialDividends());
})


// save more than one file temporarily in disk
const upload = multer({ dest: 'uploads/' })
routes.post('/upload-report-file', upload.array('reports'), async function(request: any, response: any) {
  let firstDate = new Date(9999, 1, 1);
  let lastDate = new Date(0);
  let firstDateQuery = await client.query('SELECT date FROM finance_data ORDER BY date ASC LIMIT 1');
  if (firstDateQuery.rows.length > 0) {
    firstDate = firstDateQuery.rows[0].date;
    let lastDateQuery = await client.query('SELECT date FROM finance_data ORDER BY date DESC LIMIT 1');
    if (lastDateQuery.rows.length > 0) {
      lastDate = lastDateQuery.rows[0].date;
    }
  }
  
  for (let file of request.files) {
    const workSheetsFromFile = XLSX.parse(file.path);
    for (let row of workSheetsFromFile[0].data) {
      if (row[1] != 'Data') {
        if (row[2] == 'Compra' || row[2] == 'Dividendo' || row[2] == 'Juros Sobre Capital Próprio' || row[2] == 'Rendimento' || row[2] == 'Transferência - Liquidação' || row[2] == 'Desdobro' || row[2] == 'Atualização') {
          row[1] = row[1].split('/').reverse().join('-');
          let dateObject = new Date(row[1]);
          if (dateObject < firstDate || dateObject > lastDate) {
            if (row[6] == '-') {
              row[6] = 0;
            }
            if (row[7] == '-') {
              row[7] = 0;
            }
            row[5] = row[5].replace(',', '.');
            await client.query('INSERT INTO finance_data (date, movement, product, quantity, unit_price, operation_value) VALUES ($1, $2, $3, $4, $5, $6)', [row[1], row[2], row[3], row[5], row[6], row[7]])
          }
        }
      }
    }
  }

  // select the products, quantity that has movement Desdobro
  let products_with_desdobro = await client.query('SELECT product, quantity FROM finance_data WHERE movement = \'Desdobro\'');
  products_with_desdobro = products_with_desdobro.rows;
  if (products_with_desdobro.length > 0) {
    // for each product, get the sum of quantity when movement is Transferência - Liquidação
    let products_with_desdobro_with_quantity = await Promise.all(products_with_desdobro.map(async function(item: any) {
      let quantity = await client.query('SELECT SUM(quantity) FROM finance_data WHERE movement = \'Transferência - Liquidação\' AND product = $1::text', [item.product]);
      quantity = quantity.rows[0].sum;
      return {
        product: item.product,
        quantity: quantity
      }
    }));

    let new_quantity_products = products_with_desdobro_with_quantity.map(function(item: any) {
      let desdobro_quantity = products_with_desdobro.find(function(item2: any) {return item2.product === item.product}).quantity;
      let new_quantity_math = Number((Number(item.quantity) + Number(desdobro_quantity)) / Number(item.quantity));
      return {
        product: item.product,
        new_quantity: new_quantity_math
      }
    });

    // for product in new_quantity_products, update the quantity to quantity multiplied by new_quantity and unit_price to unit_price divided by new_quantity and operation_value to operation_value divided by new_quantity in finance_data
    await Promise.all(new_quantity_products.map(async function(item: any) {
      // select the unit_price, quantity and operation_value of the product
      let product_data = await client.query('SELECT unit_price, quantity, operation_value, date FROM finance_data WHERE product = $1', [item.product]);
      for (let row of product_data.rows) {
        let new_unit_price = Number(row.unit_price) / Number(item.new_quantity);
        let new_operation_value = Number(row.operation_value) / Number(item.new_quantity);
        let new_quantity = Number(row.quantity) * Number(item.new_quantity);
        await client.query('UPDATE finance_data SET quantity = $1, unit_price = $2, operation_value = $3 WHERE product = $4 AND date = $5', [new_quantity, new_unit_price, new_operation_value, item.product, row.date]);
      }
    }));

    // delete the rows with movement Desdobro
    await client.query('DELETE FROM finance_data WHERE movement = \'Desdobro\'');
  }

  // select the products and quantity where movement is Atualização
  let products_with_atualizacao = await client.query('SELECT product, quantity FROM finance_data WHERE movement = \'Atualização\'');
  products_with_atualizacao = products_with_atualizacao.rows;
  if (products_with_atualizacao.length > 0) {
    // for each row in products_with_atualizacao, get the other products that have the same quantity
    let products_with_atualizacao_with_quantity = await Promise.all(products_with_atualizacao.map(async function(item: any) {
      // select product from finance_data having sum of quantity group by product equals the quantity of the item
      let products = await client.query('SELECT split_part(product::text, \' \', 1) FROM finance_data WHERE movement = \'Transferência - Liquidação\' GROUP BY split_part(product::text, \' \', 1) HAVING SUM(quantity) = $1', [item.quantity]);
      // let products = await client.query('SELECT product FROM finance_data WHERE quantity = $1', [item.quantity]);
      products = products.rows;
      // products equals a list with the value of each key from products
      products = products.map(function(item2: any) {
        return item2.split_part;
      });
      return {
        product: item.product,
        quantity: item.quantity,
        products: products
      }
    }));

    // for each product in products_with_atualizacao_with_quantity, try to find the historical data in yahoo finance
    await Promise.all(products_with_atualizacao_with_quantity.map(async function(item: any) {
      // create a for loop to get the historical data of the product
      for (let i = 0; i < item.products.length; i++) {
        let queryOptions = { period1: '2021-01-01'};
        try {
          let quotes = await yahooFinance.historical((item.products[i].split(' ')[0] + '.SA'), queryOptions);
        } catch (err) {
          // if the product is not found in yahoo finance, change all the items with the product like the product in the item
          await client.query('UPDATE finance_data SET product = $1 WHERE product LIKE $2', [item.product, item.products[i] + '%']);
          i = item.products.length;
        }
      }
    }));

    // delete the rows with movement Atualização
    await client.query('DELETE FROM finance_data WHERE movement = \'Atualização\'');
      
  }

  return response.json({ message: 'Hello World' })
})

// create a route that calls the function transformFinanceData with a json as input
routes.post('/transform-finance-data', async function(request: any, response: any) {
  let newdata = await manage_data.transformFinanceData(request.body.financeData, request.body.withDividends);
  return response.json(newdata);
})


routes.post('/posts', (request: any, response: any) => {
  return response.json({ message: 'New post' })
})

module.exports = routes;
