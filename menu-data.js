'use strict';
// Starting menu (from the ARK Cafe menu board). Used only to seed an empty database.
const AO={Egg:20,Vegetables:20,'Taco Beef':30,Bacon:30};
const HI=(c,a)=>a.map(([n,h,i])=>({c,n,p:{Hot:h,Iced:i}})),RG=(c,a,ao,suf='')=>a.map(([n,p])=>({c,n:n+suf,p:{Regular:p},ao}));
const MENU=[...HI('Specialty Coffee',[['Vietnamese Latte',145,145],['Spanish Latte',150,150],['Caramel Latte',150,150],['White Cafe Mocha',150,150],['Butter Scotch Latte',150,150],['Salted Caramel',150,150],['Caramel Macchiato',160,160],['Hazelnut Latte',150,150],['Tiramisu Latte',150,150]]),
{c:'Classic Coffee',n:'Espresso',p:{Hot:70}},...HI('Classic Coffee',[['Cafe Latte',140,140],['Cappuccino',140,140],['Cafe Mocha',150,150],['Americano',130,130]]),
...RG('Milk Based',[['Strawberry Milk',160],['Chocolate Milk',160],['Caramel Milk',160],['Salted Caramel Milk',160],['Butter Scotch Milk',160]]),
...RG('Smoothies',[['Strawberry',170],['Green Apple',170],['Peach',170],['Lychee',170],['Mango',170],['Blueberry',170],['Dark Chocolate',175],['Caramel & Cream',175],['White Chocolate',175],['Butter Scotch',175],['Salted Caramel',175],['Oreo',175]],0,' Smoothie'),
...RG('Frappe',[['Dark Mocha',170],['White Mocha',170],['Cappuccino',165],['Coffee Caramel',170],['Butter Scotch',170],['Salted Caramel',170]],0,' Frappe'),
...RG('Matcha Collection',[['Spanish Matcha',170],['Strawberry Matcha',175],['Matcha Smoothie',185],['Matcha Espresso',180],['Matcha Espresso Frappe',195],['Tiramisu Matcha',175]]),
...RG('Fruit Tea',[['Green Apple',150],['Peach',150],['Strawberry',150],['Kiwi',150],['Lychee',150],['Mango',150],['Blueberry',150],['Passion Fruit',150]],0,' Tea'),
...RG('Others',[['Bottled Water',20],['Coke Regular',60],['Coke Zero',60]]),
...RG('Classic Rice Bowl',[['Pork BBQ',199],['Pork Tocino',199],['Beef Tapa',199],['Lechon Kawali Rice Bowl',199]]),
...RG('Chicken Popcorn Rice Bowl',[['Spicy Buffalo Popcorn',195],['Garlic Parmesan Popcorn',195],['Sweet Chili Popcorn',195]]),
...RG('Chicken Fillet Rice Bowl',[['Chicken Fillet in Spicy Buffalo Rice',199],['Chicken Fillet in Sweet & Chili Rice',199],['Chicken Fillet in Garlic Parmesan Rice',199],['Chicken Ala King Rice',199]]),
...RG('Waffles & Grilled Cheese',[['Caramel Waffle',150],['Oreo Waffle',160],['Chocolate Waffle',150],['Grilled Cheese w/ Eggs',160],['Grilled Cheese w/ Bacon',160],['Grilled Cheese w/ Taco Beef',160],['Grilled Cheese w/ Tomato & Olives',160]],true),
...RG('White Sauce Pasta',[['Chicken Alfredo',199],['Chicken Alfredo w/ Truffle',230],['Chicken Alfredo w/ Mushroom',230],['Carbonara',199],['Carbonara w/ Truffle',230],['Carbonara w/ Mushroom',230],['Tuna Pesto',199],['Tuna Pesto w/ Truffle',265],['Tuna Pesto w/ Mushroom',235],['Tuna Pesto with Shrimp',265]]),
...RG('Oil Based Pasta',[['Aglio Olio w/ Chicken',230],['Aglio Olio w/ Bacon',230],['Aglio Olio w/ Tuna',230],['Oil Based Chicken Pesto',250],['Oil Based Bacon w/ Pesto',250],['Oil Based Tuna Pesto',250],['Oil Based Shrimp w/ Pesto',260]]),
...RG('Snacks & Appetizers',[['Flavored Fries (BBQ)',150],['Flavored Fries (Cheese)',150],['Flavored Fries (Sour & Cream)',150],['Taco Beef Cheese Fries',199],['Nachos',180],['Nachos Overload',220],['Chicken Nuggets',125],['Chicken Popcorn',185],['Chicken Combo Platter (good for sharing)',499]])].map((m,i)=>({id:i+1,...m}));
module.exports={AO,MENU};
