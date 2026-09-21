import { expect, test } from "@playwright/test"

test.beforeEach(async ({ page }) => {
  await page.route("**/api/auth/session", (route) => route.fulfill({
    status: 401,
    contentType: "application/json",
    body: JSON.stringify({ error: "authentication required" }),
  }))
  await page.route("**/api/auth/refresh", (route) => route.fulfill({
    status: 401,
    contentType: "application/json",
    body: JSON.stringify({ error: "authentication required" }),
  }))
})

test("shows its sign-in form and reports rejected credentials", async ({ page }) => {
  await page.route("**/api/auth/login", (route) => route.fulfill({
    status: 401,
    contentType: "application/json",
    body: JSON.stringify({ error: "invalid credentials" }),
  }))

  await page.goto("/")
  await expect(page.getByText("Sign in", { exact: true }).first()).toBeVisible()

  await page.getByLabel("Username").fill("test-user")
  await page.getByLabel("Password").fill("incorrect-password")
  await page.getByRole("button", { name: "Sign in" }).click()

  await expect(page.getByRole("alert")).toContainText("invalid credentials")
})
