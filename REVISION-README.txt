ARK CAFE — CORRECTED SYSTEM (FIFTH REVISION)

INSTALL ON EXISTING PROJECT
1. Back up the project, including its data directory.
2. If upgrading from Version 2 or 3, replace public/index.html only.
   If upgrading from an older release, also replace server.js.
   Copy reset-password.js beside server.js if it is missing.
3. Keep the existing data, menu-data.js, schema.sql, logo and deployment configuration.
4. Restart using Node.js 22.13 or newer: node server.js
5. Open http://localhost:3000 (or your configured port). Refresh the browser.

The ZIP also runs independently with a new database. To try demo accounts on an
empty database only, use DEMO=1 (PowerShell: $env:DEMO='1'; node server.js).
Do not use demo credentials in production. No existing database is bundled.

CORRECTIONS
General: account header displays name only, not the role. Role permissions and
admin role selection are retained. Non-editable text caret is hidden; editable
fields retain their normal caret to make typing usable.
Customer: prices appear immediately beside names in parentheses, without the
peso symbol. Flavored Fries groups BBQ, Cheese, and Sour & Cream; Nachos groups
Regular and Overload. Grouping is a customer display feature based on the
existing menu records, so product IDs, prices, and historical orders remain
unchanged. Taco Beef Cheese Fries remains a separate menu item. Add to Cart
replaces Add to order; the chosen option and price carry through to checkout.
Admin: inventory navigation, widgets, and API endpoints removed. Existing
inventory data, if present, is not deleted. Top-selling list shows names only,
with ranking still calculated by units sold. Account deletion requires explicit
confirmation. Weekly and monthly chart bars show actual calendar dates; today's
chart shows its date and hour intervals in Philippine time.
Employee: each ordered item appears on its own receipt line without a bullet,
with quantity, variant, and line total.

VALIDATION
Node syntax checks, local API login and order tests, and JavaScript rendering
assertions for grouped items, price display, variant selection, cart totals,
admin chart dates, confirmation cancel/accept and employee receipt lines passed.
Browser-based visual and mobile testing remains to be done.

THIRD REVISION — ADMIN DASHBOARD
The admin revenue trend panel is removed. Orders per period displays the
previous seven Philippine calendar days plus today (eight dates), even when
Today is selected for the other analytics. Last 30 days displays 30 dates
including today. Every day has a visible count, including zero. Counts include
confirmed, preparing, ready and received orders, excluding pending and rejected
orders, using the latest 500 order records supplied by the existing API. The
chart rolls over at Philippine midnight while the dashboard is open. Employee
revenue trend is unchanged. No database migration is required.

PASSWORD RESET
The original reset-password.js is now included. For an existing local database,
run node reset-password.js admin@arkcafe.ph from the project folder. Use the
password printed in the terminal. The script changes the password and revokes
existing sessions; it does not remove orders or accounts.

V3 VALIDATION
Node syntax checks and automated rendering assertions passed for 8-day minimum,
30-day view, Philippine date boundaries, empty periods, status filtering,
year rollover, and admin/employee panel visibility. No full browser testing.

FOURTH REVISION — PRODUCT MANAGEMENT
Added a grouped category sidebar matching the customer menu, including All
Products and category counts. Search filters names immediately within the
selected category; choose All Products to search the whole menu. Clear resets
the search. Add Product defaults to the selected category. Existing product
IDs, category controls, and database are unchanged. Node syntax and automated
rendering/event tests passed; browser and mobile visual testing not performed.

FIFTH REVISION — CUSTOMER MENU
Added live menu search by item or grouped variant name. Typing a new search
starts across all categories; selecting a category narrows the current search.
All Menu and Clear controls are provided. Prices are displayed directly next to
names, separated by a colon, with no parentheses or peso sign. Customization
prices update when a variant is chosen. Existing product IDs and prices remain
unchanged. Node syntax and automated search/render/cart tests passed; full
browser and mobile testing not performed for this revision.
