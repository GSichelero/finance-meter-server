const express1 = require('express');
const cors = require('cors');
const mainRoutes = require('./routes');

const app = express1()

const port = process.env.PORT || 3000

app.use(cors())
app.use(mainRoutes)

app.listen(port, () => {
  console.log('Server running')
})
