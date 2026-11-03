import { expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import { render } from "../../../test/render";
import { ArchivedThreadDeleteButton } from "./ArchivedThreadDeleteButton";

it("deletes only on a second click, in place, and Escape backs out", async () => {
  const onDelete = vi.fn(async () => {});
  await using screen = await render(
    <ArchivedThreadDeleteButton title="Old thread" onDelete={onDelete} />,
  );

  await screen.getByRole("button", { name: "Delete Old thread" }).click();
  const confirm = screen.getByRole("button", { name: "Confirm Permanent Delete" });
  await expect.element(confirm).toHaveFocus();
  expect(onDelete).not.toHaveBeenCalled();

  await userEvent.keyboard("{Escape}");
  await expect.element(screen.getByRole("button", { name: "Delete Old thread" })).toBeVisible();
  expect(onDelete).not.toHaveBeenCalled();

  await screen.getByRole("button", { name: "Delete Old thread" }).click();
  await screen.getByRole("button", { name: "Confirm Permanent Delete" }).click();
  expect(onDelete).toHaveBeenCalledOnce();
});
