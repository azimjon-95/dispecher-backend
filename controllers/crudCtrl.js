const { AuditLog } = require('../models')

/**
 * crudCtrl(Model, searchFields)
 * Returns { getAll, getOne, create, update, remove }
 */
function crudCtrl(Model, searchFields = []) {
  return {
    // GET /  ?page=1&limit=20&search=&status=
    getAll: async (req, res) => {
      try {
        const { page = 1, limit = 50, search, ...filters } = req.query
        const q = { deletedAt: { $exists: false } }

        if (search && searchFields.length) {
          q.$or = searchFields.map(f => ({ [f]: { $regex: search, $options: 'i' } }))
        }

        // apply simple filters (status, type, etc.)
        const ALLOWED = ['status', 'type', 'role', 'month', 'worker', 'driver']
        ALLOWED.forEach(k => { if (filters[k]) q[k] = filters[k] })

        const skip = (Number(page) - 1) * Number(limit)
        const [data, total] = await Promise.all([
          Model.find(q).sort({ createdAt: -1 }).skip(skip).limit(Number(limit)).lean(),
          Model.countDocuments(q),
        ])
        res.json({ data, total, page: Number(page), pages: Math.ceil(total / limit) })
      } catch (e) {
        res.status(500).json({ error: e.message })
      }
    },

    // GET /:id
    getOne: async (req, res) => {
      try {
        const doc = await Model.findById(req.params.id).lean()
        if (!doc) return res.status(404).json({ error: 'Topilmadi' })
        res.json(doc)
      } catch (e) {
        res.status(500).json({ error: e.message })
      }
    },

    // POST /
    create: async (req, res) => {
      try {
        const doc = await Model.create(req.body)
        AuditLog.create({ action: 'CREATE', resource: Model.modelName, data: req.body, by: req.user?.id }).catch(() => {})
        res.status(201).json(doc)
      } catch (e) {
        res.status(400).json({ error: e.message })
      }
    },

    // PUT /:id
    update: async (req, res) => {
      try {
        const doc = await Model.findByIdAndUpdate(
          req.params.id,
          { $set: req.body },
          { new: true, runValidators: true }
        ).lean()
        if (!doc) return res.status(404).json({ error: 'Topilmadi' })
        AuditLog.create({ action: 'UPDATE', resource: Model.modelName, data: req.body, by: req.user?.id }).catch(() => {})
        res.json(doc)
      } catch (e) {
        res.status(400).json({ error: e.message })
      }
    },

    // DELETE /:id  → soft delete
    remove: async (req, res) => {
      try {
        const doc = await Model.findByIdAndUpdate(
          req.params.id,
          { deletedAt: new Date() },
          { new: true }
        )
        if (!doc) return res.status(404).json({ error: 'Topilmadi' })
        AuditLog.create({ action: 'DELETE', resource: Model.modelName, data: { id: req.params.id }, by: req.user?.id }).catch(() => {})
        res.json({ ok: true })
      } catch (e) {
        res.status(500).json({ error: e.message })
      }
    },
  }
}

module.exports = crudCtrl
