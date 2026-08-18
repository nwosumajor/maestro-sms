// The page a family lands on from the link the school sent them.
//
// A SERVER shell around a client component, and that is not incidental: route
// segment config is only honoured in a server file, and this page must render
// per request. The CSP in middleware.ts carries a per-request nonce, while a
// prerendered page's HTML is built ONCE — so its script tags can never match and
// every script on the page is refused. The page then serves perfectly and does
// nothing at all, which is the worst way for it to fail.
export const dynamic = "force-dynamic";

import { FamilyDocuments } from "@/components/documents/FamilyDocuments";

export default function FamilyDocumentsPage() {
  return <FamilyDocuments />;
}
