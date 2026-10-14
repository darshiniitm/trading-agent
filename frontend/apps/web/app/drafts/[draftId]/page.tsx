import { DraftEditor } from "@/components/DraftEditor";

// An existing draft — the target of "Edit as new version" and of the Drafts
// tab's "Continue" link. Loads the draft rather than creating a new one.
// (/drafts/new is a static segment, so it takes precedence over this route.)
export default function ExistingDraftPage({ params }: { params: { draftId: string } }) {
  return <DraftEditor initialDraftId={Number(params.draftId)} />;
}
