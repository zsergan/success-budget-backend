import { TransactionType } from './enums';
import { CreateCategoryDto } from '@modules/categories/dto/create-category.dto';

export const MAX_CONFIRMATION_CODE_ATTEMPTS = 5;

const DEFAULT_ICON_COLOR = '#222831';

export const DEFAULT_CATEGORIES: CreateCategoryDto[] = [
  { name: 'Salary', transaction_type: TransactionType.INCOME, icon: 'paid', color: DEFAULT_ICON_COLOR },
  { name: 'Gift', transaction_type: TransactionType.INCOME, icon: 'card-giftcard', color: DEFAULT_ICON_COLOR },
  { name: 'Housing', transaction_type: TransactionType.EXPENSE, icon: 'home', color: DEFAULT_ICON_COLOR },
  {
    name: 'Transportation',
    transaction_type: TransactionType.EXPENSE,
    icon: 'directions-bus',
    color: DEFAULT_ICON_COLOR,
  },
  { name: 'Groceries', transaction_type: TransactionType.EXPENSE, icon: 'shopping-basket', color: DEFAULT_ICON_COLOR },
  { name: 'Restaurants', transaction_type: TransactionType.EXPENSE, icon: 'fastfood', color: DEFAULT_ICON_COLOR },
  { name: 'Car', transaction_type: TransactionType.EXPENSE, icon: 'directions-car', color: DEFAULT_ICON_COLOR },
  { name: 'Clothing', transaction_type: TransactionType.EXPENSE, icon: 'checkroom', color: DEFAULT_ICON_COLOR },
  { name: 'Health', transaction_type: TransactionType.EXPENSE, icon: 'healing', color: DEFAULT_ICON_COLOR },
  {
    name: 'Entertainment',
    transaction_type: TransactionType.EXPENSE,
    icon: 'sports-esports',
    color: DEFAULT_ICON_COLOR,
  },
  { name: 'Education', transaction_type: TransactionType.EXPENSE, icon: 'school', color: DEFAULT_ICON_COLOR },
  { name: 'Rent', transaction_type: TransactionType.EXPENSE, icon: 'money', color: DEFAULT_ICON_COLOR },
  { name: 'Travel', transaction_type: TransactionType.EXPENSE, icon: 'flight', color: DEFAULT_ICON_COLOR },
  { name: 'Pets', transaction_type: TransactionType.EXPENSE, icon: 'pets', color: DEFAULT_ICON_COLOR },
  { name: 'Electronics', transaction_type: TransactionType.EXPENSE, icon: 'cable', color: DEFAULT_ICON_COLOR },
  { name: 'Utilities', transaction_type: TransactionType.EXPENSE, icon: 'water-drop', color: DEFAULT_ICON_COLOR },
];
