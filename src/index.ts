const express1 = require('express');
const cors = require('cors');
const mainRoutes = require('./routes');

const app = express1()

const port = process.env.PORT || 3000

app.use(function(req: any, res: any, next: any) {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Headers", "Origin, X-Requested-With, Content-Type, Accept");
  next();
});

app.use(mainRoutes)

app.listen(port, () => {
  console.log('Server running')
})
