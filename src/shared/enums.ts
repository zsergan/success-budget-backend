export enum TransactionType {
  INCOME = 'income',
  EXPENSE = 'expense',
}

// shared by Wallet.design and Category.color - one closed palette of 6 tones
export enum AppColor {
  SLATE = 'slate',
  AMBER = 'amber',
  EVERGREEN = 'evergreen',
  INDIGO = 'indigo',
  CLAY = 'clay',
  PLUM = 'plum',
}

export enum CategoryIcon {
  GROCERY = 'Grocery',
  RESTAURANT = 'Restaurant',
  CAFE = 'Cafe',
  HOUSING = 'Housing',
  UTILITIES = 'Utilities',
  INTERNET = 'Internet',
  TRANSPORT = 'Transport',
  FUEL = 'Fuel',
  CAR = 'Car',
  TAXI = 'Taxi',
  HEALTH = 'Health',
  PHARMACY = 'Pharmacy',
  FITNESS = 'Fitness',
  BEAUTY = 'Beauty',
  CLOTHES = 'Clothes',
  ELECTRONICS = 'Electronics',
  HOME_GOODS = 'Home goods',
  EDUCATION = 'Education',
  KIDS = 'Kids',
  PETS = 'Pets',
  TRAVEL = 'Travel',
  ENTERTAINMENT = 'Entertainment',
  SUBSCRIPTIONS = 'Subscriptions',
  GIFTS = 'Gifts',
  CHARITY = 'Charity',
  FEES = 'Fees',
  TAXES = 'Taxes',
  SAVINGS = 'Savings',
  SALARY = 'Salary',
  BONUS = 'Bonus',
  FREELANCE = 'Freelance',
  INVESTMENTS = 'Investments',
  DIVIDENDS = 'Dividends',
  REFUND = 'Refund',
  OTHER = 'Other',
}

export enum ConfirmationType {
  EMAIL = 'email',
  RESET_PASSWORD = 'reset_password',
}

export enum LimitType {
  CATEGORY = 'category',
  OTHERS = 'others',
}
