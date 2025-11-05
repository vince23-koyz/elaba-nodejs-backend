const express = require("express");
const router = express.Router();
const transactionController = require("../controllers/TransactionHistoryController");

// Routes
router.get("/", transactionController.getTransactions);
router.get("/:id", transactionController.getTransactionById);
router.post("/", transactionController.createTransaction);
router.put("/:id", transactionController.updateTransaction);
router.delete("/:id", transactionController.deleteTransaction);

module.exports = router;
