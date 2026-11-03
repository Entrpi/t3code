import type { EnvironmentId } from "@t3tools/contracts";
import type {
  ComposerFileAttachment,
  ComposerImageAttachment,
  ComposerThreadTarget,
} from "../../composerDraftStore";
import {
  awaitAttachmentUploads,
  getUploadedAttachments,
  startAttachmentUpload,
} from "../../lib/attachmentUploadQueue";
import { appAtomRegistry } from "../../rpc/atomRegistry";
import { environmentServerConfigsAtom } from "../../state/server";
import { fileAttachmentCapabilityBlockReason } from "./composerAttachmentFiles";

/** Uploads an edit's new attachments to the environment and returns them as pending uploads. */
export async function uploadComposerAttachments(input: {
  readonly environmentId: EnvironmentId;
  readonly attachments: ReadonlyArray<ComposerImageAttachment | ComposerFileAttachment>;
  readonly draftTarget?: ComposerThreadTarget;
}) {
  const { environmentId, attachments } = input;
  const validateFiles = () => {
    const config = appAtomRegistry.get(environmentServerConfigsAtom).get(environmentId) ?? null;
    const reason = fileAttachmentCapabilityBlockReason({
      files: attachments.filter((attachment) => attachment.type === "file"),
      attachmentUploadsCapabilityKnown: config !== null,
      supportsAttachmentUploads: config !== null,
      maxFileAttachmentBytes:
        config?.environment.capabilities.fileAttachments?.maxUploadBytes ?? null,
    });
    if (reason !== null) throw new Error(reason);
  };
  validateFiles();
  for (const attachment of attachments) {
    startAttachmentUpload({
      environmentId,
      image: attachment,
      ...(input.draftTarget === undefined ? {} : { draftTarget: input.draftTarget }),
    });
  }
  await awaitAttachmentUploads(attachments.map((attachment) => attachment.id));
  validateFiles();
  const uploaded = getUploadedAttachments({ environmentId, images: attachments });
  if (uploaded === null) throw new Error("Retry or remove failed uploads before saving.");
  return uploaded;
}
