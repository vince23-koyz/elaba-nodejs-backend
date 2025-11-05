const db = require("../config/db");

// ✅ Get all transactions
exports.getTransactions = async (req, res) => {
  try {
    const [result] = await db.query("SELECT * FROM transaction ORDER BY created_at DESC");
    res.json(result);
  } catch (err) {
    console.error("DB Error (getTransactions):", err);
    res.status(500).json({ message: "Database error", error: err.message });
  }
};

// ✅ Get transaction by ID
exports.getTransactionById = async (req, res) => {
  const { id } = req.params;

  try {
    const [result] = await db.query("SELECT * FROM transaction WHERE transaction_id = ?", [id]);
    if (result.length === 0) return res.status(404).json({ message: "Transaction not found" });

    res.json(result[0]);
  } catch (err) {
    console.error("DB Error (getTransactionById):", err);
    res.status(500).json({ message: "Database error", error: err.message });
  }
};

// ✅ Create new transaction
exports.createTransaction = async (req, res) => {
  const { date, total_payment } = req.body;

  if (!date || !total_payment) {
    return res.status(400).json({ message: "Date and total_payment are required" });
  }

  try {
    const sql = "INSERT INTO transaction (date, total_payment) VALUES (?, ?)";
    const [result] = await db.query(sql, [date, total_payment]);

    res.status(201).json({
      message: "Transaction created successfully",
      transaction_id: result.insertId,
    });
  } catch (err) {
    console.error("DB Error (createTransaction):", err);
    res.status(500).json({ message: "Database error", error: err.message });
  }
};

// ✅ Update transaction (optional, e.g. to modify total_payment)
exports.updateTransaction = async (req, res) => {
  const { id } = req.params;
  const { date, total_payment } = req.body;

  if (!date && !total_payment) {
    return res.status(400).json({ message: "At least one field (date or total_payment) is required" });
  }

  try {
    const sql = `
      UPDATE transaction 
      SET 
        date = COALESCE(?, date), 
        total_payment = COALESCE(?, total_payment) 
      WHERE transaction_id = ?
    `;
    const [result] = await db.query(sql, [date, total_payment, id]);

    if (result.affectedRows === 0) return res.status(404).json({ message: "Transaction not found" });
    res.json({ message: "Transaction updated successfully" });
  } catch (err) {
    console.error("DB Error (updateTransaction):", err);
    res.status(500).json({ message: "Database error", error: err.message });
  }
};

// ✅ Delete transaction
exports.deleteTransaction = async (req, res) => {
  const { id } = req.params;

  try {
    const [result] = await db.query("DELETE FROM transaction WHERE transaction_id = ?", [id]);
    if (result.affectedRows === 0) return res.status(404).json({ message: "Transaction not found" });

    res.json({ message: "Transaction deleted successfully" });
  } catch (err) {
    console.error("DB Error (deleteTransaction):", err);
    res.status(500).json({ message: "Database error", error: err.message });
  }
};
