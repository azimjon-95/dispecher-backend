const router = require('express').Router()
const ctrl   = require('../controllers/crudCtrl')
const { Price } = require('../models')

const c = ctrl(Price, ['name'])
router.get('/',       c.getAll)
router.get('/:id',    c.getOne)
router.post('/',      c.create)
router.put('/:id',    c.update)
router.delete('/:id', c.remove)

module.exports = router
