// eLaba-backend/src/controllers/serviceController.js
const db = require('../config/db');
const DEFAULT_SERVICE_PACKAGE = 'Regular Service';

const validateWeightPricing = (maxKg, priceTiers) => {
  const normalizedMaxKg = Number(maxKg);
  if (!Number.isInteger(normalizedMaxKg) || normalizedMaxKg < 1 || normalizedMaxKg > 9) {
    return { error: 'max_kg must be a whole number from 1 to 9.' };
  }

  let tiers = priceTiers;
  if (typeof tiers === 'string') {
    try {
      tiers = JSON.parse(tiers);
    } catch {
      return { error: 'price_tiers must be a valid array.' };
    }
  }

  if (!Array.isArray(tiers) || tiers.length === 0) {
    return { error: 'At least one price tier is required.' };
  }

  let previousMax = 0;
  const normalizedTiers = [];
  for (const tier of tiers) {
    const tierMax = Number(tier?.max_kg);
    const tierPrice = Number(tier?.price);
    if (!Number.isInteger(tierMax) || tierMax <= previousMax || tierMax > normalizedMaxKg) {
      return { error: 'Price tier kg limits must increase and stay within max_kg.' };
    }
    if (!Number.isFinite(tierPrice) || tierPrice <= 0) {
      return { error: 'Every price tier must have a price greater than zero.' };
    }
    normalizedTiers.push({ max_kg: tierMax, price: tierPrice });
    previousMax = tierMax;
  }

  if (previousMax !== normalizedMaxKg) {
    return { error: 'The final price tier kg limit must match max_kg.' };
  }

  return { maxKg: normalizedMaxKg, tiers: normalizedTiers };
};

// CREATE Service
exports.createService = async (req, res) => {
  console.log("REQ.BODY:", req.body);

  const { offers, quantity, description, price, shop_id, status, max_kg, price_tiers } = req.body;

  if (!shop_id) {
    return res.status(400).json({ message: "Shop ID is required" });
  }

  const weightPricing = validateWeightPricing(max_kg, price_tiers);
  if (weightPricing.error) {
    return res.status(400).json({ message: weightPricing.error });
  }

  try {
    const startingPrice = weightPricing.tiers[0].price;
    const sql = `INSERT INTO services
      (offers, quantity, description, price, package, shop_id, status, max_kg, price_tiers)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`;
    const [result] = await db.query(sql, [
      offers, quantity, description, startingPrice, DEFAULT_SERVICE_PACKAGE, shop_id, status,
      weightPricing.maxKg, JSON.stringify(weightPricing.tiers),
    ]);

    res.status(201).json({ 
      success: true,
      message: "Service added successfully", 
      service_id: result.insertId
    });
  } catch (err) {
    console.error("DB Error (createService):", err);
    res.status(500).json({ error: err.message });
  }
};

// GET ALL Services
exports.getServices = async (req, res) => {
  try {
    const [results] = await db.query(`
      SELECT services.*, shop.name AS shop_name
      FROM services
      LEFT JOIN shop ON services.shop_id = shop.shop_id
    `);
    res.json(results);
  } catch (err) {
    console.error("DB Error (getServices):", err);
    res.status(500).json({ message: 'Database error', error: err.message });
  }
};

// GET Service by ID
exports.getServiceById = async (req, res) => {
  const { id } = req.params;

  try {
    const [results] = await db.query('SELECT * FROM services WHERE service_id = ?', [id]);
    
    if (results.length === 0) return res.status(404).json({ message: 'Service not found' });
    res.json(results[0]);
  } catch (err) {
    console.error("DB Error (getServiceById):", err);
    res.status(500).json({ message: 'Database error', error: err.message });
  }
};

// GET Services by Shop ID
exports.getServicesByShop = async (req, res) => {
  const { shop_id } = req.params;

  if (!shop_id) {
    return res.status(400).json({ message: "Shop ID is required" });
  }

  try {
    const sql = "SELECT * FROM services WHERE shop_id = ?";
    const [results] = await db.query(sql, [shop_id]);
    
    if (results.length === 0) return res.status(404).json({ message: 'No services found for this shop' });
    res.json(results);
  } catch (err) {
    console.error("DB Error (getServicesByShop):", err);
    res.status(500).json({ message: 'Database error', error: err.message });
  }
};

// UPDATE Service
exports.updateService = async (req, res) => {
  const { id } = req.params;
  const { offers, quantity, description, status, max_kg, price_tiers } = req.body;

  const weightPricing = validateWeightPricing(max_kg, price_tiers);
  if (weightPricing.error) {
    return res.status(400).json({ message: weightPricing.error });
  }

  try {
    const sql = `UPDATE services 
                SET offers=?, quantity=?, description=?, price=?, package=?, status=?, max_kg=?, price_tiers=?
                WHERE service_id=?`;

    const [result] = await db.query(sql, [
      offers, quantity, description, weightPricing.tiers[0].price, DEFAULT_SERVICE_PACKAGE, status,
      weightPricing.maxKg, JSON.stringify(weightPricing.tiers), id,
    ]);
    
    if (result.affectedRows === 0) return res.status(404).json({ message: 'Service not found' });
    res.json({ message: 'Service updated successfully' });
  } catch (err) {
    console.error("DB Error (updateService):", err);
    res.status(500).json({ message: 'Database error', error: err.message });
  }
};

// DELETE Service
exports.deleteService = async (req, res) => {
  const { id } = req.params;

  try {
    const [result] = await db.query('DELETE FROM services WHERE service_id = ?', [id]);
    
    if (result.affectedRows === 0) return res.status(404).json({ message: 'Service not found' });
    res.json({ message: 'Service deleted successfully' });
  } catch (err) {
    console.error("DB Error (deleteService):", err);
    res.status(500).json({ message: 'Database error', error: err.message });
  }
};
