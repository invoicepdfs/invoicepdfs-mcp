/**
 * Which operations are promoted to first-class tools, and what they are called.
 *
 * This is the only file that decides the shape of the tool surface, and it is
 * deliberately small and declarative. Everything else about a tool — its input
 * schema, its description, the HTTP call — is generated.
 *
 * Why promote at all rather than expose all 161: every client caps the tool
 * list. Cursor is around 40, Junie 100, Copilot 128. A server that offers 161
 * either breaks or crowds out every other server the user has connected. So a
 * small promoted set covers the common path and `find_operation` reaches the
 * rest on demand — a lazy load implemented here rather than relying on the
 * client to support one.
 */

export interface PromotedTool {
  /** Tool name shown to the model. */
  name: string;
  /** The generated operation it runs. */
  operationId: string;
}

/**
 * Named `document_*` rather than `invoice_*` because the product models eight
 * document types — credit notes, quotes, receipts, purchase orders and more.
 * Naming the tools after one of them would hide the other seven from a model
 * reading only the tool list.
 */
export const PROMOTED: PromotedTool[] = [
  // --- rendering: the product ---
  { name: "document_render", operationId: "render_document" },
  { name: "document_render_stored", operationId: "create_document_render" },
  { name: "document_get_render", operationId: "get_render" },
  { name: "document_download_render", operationId: "download_render" },

  // --- checking, without rendering ---
  // Cheaper than a render and the right first move for an agent: catches a bad
  // document before it costs a render off the account's quota.
  { name: "document_calculate", operationId: "calculate_document" },
  { name: "document_validate", operationId: "validate_document" },

  // --- documents ---
  { name: "document_create", operationId: "create_document" },
  { name: "document_get", operationId: "get_document" },
  { name: "document_list", operationId: "list_documents" },
  { name: "document_update", operationId: "update_document" },
  { name: "document_duplicate", operationId: "duplicate_document" },
  // document_transition covers finalize/sent/paid/unpaid/void/archive/restore.
  { name: "document_send", operationId: "send_document" },

  // --- e-invoicing: the other half of the product ---
  { name: "compliance_check", operationId: "validate_compliance" },
  { name: "compliance_xml", operationId: "render_document_xml" },

  // --- the things a document needs before it can exist ---
  { name: "customer_list", operationId: "list_customers" },
  { name: "customer_create", operationId: "create_customer" },
  { name: "customer_get", operationId: "get_customer" },
  { name: "customer_update", operationId: "update_customer" },
  { name: "business_profile_list", operationId: "list_business_profiles" },
  { name: "business_profile_create", operationId: "create_business_profile" },
  // template_id is an input on every render with no other way to discover
  // which values are valid.
  { name: "template_list", operationId: "list_templates" },

  // --- recurring ---
  { name: "recurring_create", operationId: "create_recurring_invoice" },
  { name: "recurring_list", operationId: "list_recurring_invoices" },
  { name: "recurring_pause", operationId: "pause_recurring_invoice" },
  { name: "recurring_resume", operationId: "resume_recurring_invoice" },
  { name: "recurring_cancel", operationId: "cancel_recurring_invoice" },
  { name: "recurring_generated", operationId: "list_generated_invoices" },
];

/** Operation ids the manifest names — checked against the spec at build time. */
export const PROMOTED_IDS: string[] = PROMOTED.map((t) => t.operationId);

/**
 * Seven lifecycle operations presented as one tool, keyed by the state they
 * reach.
 *
 * This lives here rather than in the tool because it is the same kind of
 * decision as `PROMOTED`: which operations are surfaced and what they are
 * called. The names on the left are the only invention — everything the tool
 * says about them is read from the spec.
 */
export const TRANSITIONS: Record<string, string> = {
  finalized: "finalize_document",
  sent: "mark_sent",
  paid: "mark_paid",
  unpaid: "mark_unpaid",
  void: "void_document",
  archived: "archive_document",
  restored: "restore_document",
};

