var googleFinance = require('google-finance');
const { Client } = require('pg')
const multer = require('multer');
var XLSX = require('node-xlsx');
const yahooFinance = require('yahoo-finance2').default;

const connectionString = process.env.DATABASE_URL;

const client = new Client({
    connectionString,
})
client.connect()

// create an async function
export async function getFinancialData() {
    let finance_data_json = await client.query('SELECT * FROM finance_data');
    // convert to json
    finance_data_json = finance_data_json.rows;

    // get all the products names, date, quantity and unit price where movement is 'Transferência - Liquidação'
    let stocks_bought = finance_data_json.filter(function (item: any) {
        return item.movement === 'Transferência - Liquidação'
    })
    stocks_bought = stocks_bought.map(function (item: any) {
        return {
            product: item.product,
            date: item.date,
            quantity: item.quantity,
            unit_price: item.unit_price
        }
    });

    // transform the item name to only the string before the first space
    stocks_bought = stocks_bought.map(function (item: any) {
        return {
            product: item.product.split(' ')[0] + '.SA',
            date: item.date,
            quantity: item.quantity,
            unit_price: item.unit_price
        }
    });

    // for item in stocks_bought, get the historical price
    let stocks_bought_with_price = await Promise.all(stocks_bought.map(async function (item: any) {
        let queryOptions = { period1: item.date };
        let historical_price = 0;
        try {
            historical_price = await yahooFinance.historical(item.product, queryOptions);
        }
        catch (err) {
            console.log(err);
        }
        return {
            product: item.product,
            type: 'Stock',
            date: item.date,
            quantity: item.quantity,
            unit_price: item.unit_price,
            history: historical_price
        }
    }));

    // select from finance_data table where movement is 'Compra'
    let stocks_sold = finance_data_json.filter(function (item: any) {
        return item.movement === 'Compra'
    })
    stocks_sold = stocks_sold.map(function (item: any) {
        return {
            product: item.product,
            type: 'Bond',
            date: item.date,
            quantity: item.quantity,
            unit_price: item.unit_price,
            history: [{"date": new Date(Number(item.product.slice(-4)), 0, 1, 0, 0, 0, 0), "close": 1000}]
        }
    });

    // add the stocks sold to the stocks bought
    stocks_bought_with_price = stocks_bought_with_price.concat(stocks_sold);

    return stocks_bought_with_price
}

export function filterData(stocks_bought_with_price: any) {
    stocks_bought_with_price = stocks_bought_with_price.map(function (item: any) {
        // for each element in item delete fields open, high, low, volume, adjClose
        for (let i = 0; i < item.history.length; i++) {
            delete item.history[i].open;
            delete item.history[i].high;
            delete item.history[i].low;
            delete item.history[i].volume;
            delete item.history[i].adjClose;
        }
        return item;
    });

    return stocks_bought_with_price
}


export async function getFinancialDividends() {
    let finance_data_json = await client.query('SELECT * FROM finance_data');
    // convert to json
    finance_data_json = finance_data_json.rows;

    // get all the products names, date, quantity and unit price where movement is 'Transferência - Liquidação'
    let stocks_bought = finance_data_json.filter(function (item: any) {
        return item.movement === 'Dividendo' || item.movement === 'Juros Sobre Capital Próprio' || item.movement === 'Rendimento'
    })
    stocks_bought = stocks_bought.map(function (item: any) {
        return {
            product: item.product.split(' ')[0] + '.SA',
            date: item.date,
            quantity: item.quantity,
            unit_price: item.unit_price
        }
    });

    return stocks_bought
}


export function getDatesInRange(startDate: Date, endDate: Date) {
    const date = new Date(startDate.getTime());
  
    const dates: any[] = [];
  
    while (date <= endDate) {
      dates.push(String(new Date(date)));
      date.setDate(date.getDate() + 1);
    }
  
    return dates;
}

export function countDaysBetweenDates(startDate: Date, endDate: Date) {
    const date = new Date(startDate.getTime());
    let count = 0;
    while (date <= endDate) {
        count++;
        date.setDate(date.getDate() + 1);
    }
    return count;
}

export async function transformFinanceData(financeData: any, withDividends: boolean) {
    // for each element in data with product containing 'Tesouro Prefixado'
    for (let i = 0; i < financeData.length; i++) {
        if (financeData[i].product.includes('Tesouro Prefixado')) {
            // add to the history of financeData[i] all the dates between the first and last date of financeData[i]
            let datesTotal = getDatesInRange(new Date(financeData[i].date), new Date(financeData[i].history[0].date));
            let dates = getDatesInRange(new Date(financeData[i].date), new Date());
            // get the count of dates between the first and last date of data[i]
            let countTotal = datesTotal.length;
            let count = dates.length;
            let buy_price = financeData[i].unit_price * financeData[i].quantity;
            let last_day_value = 1000 * financeData[i].quantity;
            let total_profit = last_day_value - buy_price;
            let profit_per_day = total_profit / countTotal;
            financeData[i].quantity = 1;
            financeData[i].unit_price = buy_price;
            // drop the first element from the history of financeData[i]
            financeData[i].history.shift();
            for (let j = 1; j < count - 1; j++) {
                financeData[i].history.push(
                    {
                        date: new Date(dates[j]).toISOString().substring(0, 10),
                        close: buy_price + (profit_per_day * j)
                    }
                )
            }
        }
    }

    for (let i = 0; i < financeData.length; i++) {
        if (financeData[i].type == 'Stock') {
            financeData[i].history.unshift(
                {
                    date: new Date(financeData[i].date).toISOString().substring(0, 10),
                    close: Number(financeData[i].unit_price)
                }
            )
        }
    }

    if (withDividends) {
        let dividends = await getFinancialDividends();
        for (let i = 0; i < dividends.length; i++) {
            let index: any;
            for (let j = 0; j < financeData.length; j++) {
                if (financeData[j].product == dividends[i].product) {
                    index = j;
                    break;
                }
            }
            // select the date of the financeData[index] before the dividends[i].date
            for (let j = financeData[index].history.length - 1; j > 0; j--) {
                if (new Date(financeData[index].history[j].date) <= new Date(dividends[i].date)) {
                    // add to the history of financeData[index] the dividends[i]
                    for (let k = j; k < financeData[index].history.length; k++) {
                        if (new Date(financeData[index].history[k].date) >= new Date(financeData[index].history[k - 1].date)) {
                            financeData[index].history[k].close = financeData[index].history[k].close + ((dividends[i].unit_price * dividends[i].quantity) / financeData[index].quantity);
                        }
                    }
                    break;
                }
            }
        }
    }

    const data: any = financeData.map((element: { history: any; quantity: any; unit_price: any; product: any;}) => {
        if (element.history != 0) {
            return element.history.map((element2: { date: any; close: any; }) => {
                return {
                    product: element.product,
                    date: element2.date,
                    quantity: element.quantity,
                    close: element2.close,
                    total_value: element.quantity * element2.close,
                    delta:  (element2.close * element.quantity) - (element.quantity * element.unit_price)
                }
            })
        }
    });

    let datesStored: any = [];
    data.forEach((element: any) => {
        element.forEach((element2: any) => {
            if (!datesStored.includes(element2.date)) {
                datesStored.push(String(element2.date));
            }
        })
    });

    // order datesStored
    datesStored = datesStored.sort((a: any, b: any) => {
        return new Date(a).getTime() - new Date(b).getTime();
    });

    let allDates: any = getDatesInRange(new Date(datesStored[0]), new Date(datesStored[datesStored.length - 1]));
    // sort allDates
    allDates = allDates.sort((a: any, b: any) => {
        return new Date(a).getTime() - new Date(b).getTime();
    });

    // delete from allDates the dates after current time
    allDates = allDates.filter((element: any) => {
        return new Date(element).getTime() <= new Date().getTime();
    });

    let dataCopy = JSON.parse(JSON.stringify(data));
    allDates.forEach((element: any) => {
        for (let i = 0; i < data.length; i++) {
            for (let j = 0; j < data[i].length; j++) {
                if (
                    new Date(String(element)) > new Date(String(data[i][0].date)) &&
                    new Date(String(element)) < new Date(String(data[i][data[i].length - 1].date))
                ) {
                    if (
                        new Date(String(data[i][j].date)) < new Date(String(element)) &&
                        new Date(String(data[i][j + 1].date)) > new Date(String(element))
                    ) {
                        let firstDay = new Date(String(data[i][j].date));
                        let element_date: any = new Date(String(element));
                        let next_date: any = new Date(String(data[i][j + 1].date));
                        let countTotalDays = countDaysBetweenDates(firstDay, next_date) - 1;
                        let countDays = countDaysBetweenDates(element_date, next_date) - 1;
                        let close = data[i][j].close + 
                            (((data[i][j + 1].close - data[i][j].close) / countTotalDays) 
                            * (countTotalDays - countDays));
                        let delta = data[i][j].delta + 
                            (((data[i][j + 1].delta - data[i][j].delta) / countTotalDays) 
                            * (countTotalDays - countDays));
                        dataCopy[i].push({
                            product: data[i][j].product,
                            quantity: data[i][j].quantity,
                            date: element,
                            close: close,
                            total_value: data[i][j].quantity * close,
                            delta: delta
                        });
                    }
                }
            }
        }
    });
    
    // map each date field inside each array in dataCopy
    dataCopy.forEach((element: any) => {
        element.forEach((element2: any) => {
            element2.date = String(new Date(String(element2.date)));
        });
    });

    for (let i = 0; i < dataCopy.length; i++) {
        dataCopy[i] = dataCopy[i].filter((element: { date: any; }) => {
            return element.date.substring(8, 10) === '01'
        })
    }

    let newDatesStored: any = [];
    dataCopy.forEach((element: any) => {
        element.forEach((element2: any) => {
            if (!newDatesStored.includes(element2.date)) {
                newDatesStored.push(String(new Date(String(element2.date))));
            }
        })
    });
    newDatesStored = newDatesStored.sort((a: any, b: any) => {
        return new Date(a).getTime() - new Date(b).getTime();
    });
    // sort all arrays in dataCopy by date
    dataCopy.forEach((element: any) => {
        element.sort((a: any, b: any) => {
            return new Date(a.date).getTime() - new Date(b.date).getTime();
        });
    });

    // add a new element to dataCopy with the sum of the close values for each date in newDatesStored
    let newData: any = [];
    newDatesStored.forEach((element: any) => {
        let sum = 0;
        let deltaSum = 0;
        let quantitySum = 0;
        let totalValueSum = 0;
        dataCopy.forEach((element2: any) => {
            element2.forEach((element3: any) => {
                if (element3.date === element) {
                    sum += element3.close;
                    deltaSum += element3.delta;
                    quantitySum += element3.quantity;
                    totalValueSum += element3.total_value;
                }
            })
        });
        newData.push({
            product: 'Total',
            date: element,
            quantity: quantitySum,
            close: sum,
            total_value: totalValueSum,
            delta: deltaSum
        })
    });
    dataCopy.push(newData);

    // filter dataCopy to remove empty arrays
    dataCopy = dataCopy.filter((element: any) => {
        return element.length > 0;
    });

    // create a new array that sums the values from the dataCopy arrays that are from the same product
    let newData2: any = [];
    dataCopy.forEach((element: any) => {
        let newProductArray: any = [];
        let product_name = element[0].product;
        // if none of the elements in the newData2 contains a product named the same as the current element
        if (newData2.length == 0 || !newData2.some((element2: any) => {
            return element2[0].product == product_name;
        }
        )) {
            dataCopy.forEach((element2: any) => {
                if (element2[0].product == product_name) {
                    element2.forEach((element3: any) => {
                        // if element3.date is already in newProductArray, sum element3.close and element3.delta to the value of the date
                        if (newProductArray.includes(element3.date)) {
                            newProductArray.forEach((element4: any) => {
                                if (element4.date === element3.date) {
                                    element4.quantity += element3.quantity;
                                    element4.total_value += element3.total_value;
                                    element4.delta += element3.delta;
                                }
                            })
                        } else {
                            newProductArray.push(element3);
                        }
                    });
                }
            });
            newData2.push(newProductArray);
        }
    });

    // for each array in newData2
    let newData3: any = [];
    newData2.forEach((element: any) => {
        // push to newData3 an array with the same elements as element, but with the sum of the close values for each date
        let newArray: any = [];
        let insertedDates: any = [];
        // for each element in element
        element.forEach((element2: any) => {
            // if element2.date is not in insertedDates
            if (!insertedDates.includes(element2.date)) {
                // push element2 to newArray
                insertedDates.push(element2.date);
                newArray.push(element2);
            } else {
                // sum element2.close and element2.delta to the value of the date in newArray
                newArray.forEach((element3: any) => {
                    if (element3.date === element2.date) {
                        element3.quantity += element2.quantity;
                        element3.total_value += element2.total_value;
                        element3.delta += element2.delta;
                    }
                });
            }
        });
        newData3.push(newArray);
    });

    // order newData3 by date
    newData3.forEach((element: any) => {
        element.sort((a: any, b: any) => {
            return new Date(a.date).getTime() - new Date(b.date).getTime();
        });
    });

    // loop through all elements in newDatesStored
    for (let i = 0; i < newDatesStored.length; i++) {
        // convert each element in newDatesStored to a String
        newDatesStored[i] = String(new Date(String(newDatesStored[i])));
    }

    return [newDatesStored, newData3];
}